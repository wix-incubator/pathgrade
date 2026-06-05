/**
 * Shared helpers for the sdk-regression eval suite.
 *
 * Goal: one real agent run per agent that exercises EVERY public SDK surface
 * relevant to that agent, so a passing suite is strong evidence that the SDK
 * is healthy end-to-end. Pure / offline exports are smoke-tested in
 * `surface-smoke.eval.ts` (no agent required).
 *
 * Coverage matrix (what the per-agent eval drives):
 *
 *   createAgent         agent, model, timeout:'auto', workspace, env,
 *                       copyIgnore, debug, conversationWindow, mcpMock
 *                       (claude/cursor), transport (codex)
 *   Agent surface       prompt(), exec(), startChat() → ChatSession.reply/
 *                       hasFile/end, transcript(), messages, log, workspace,
 *                       llm, dispose()
 *   runConversation     firstMessage, maxTurns, until, reactions (text +
 *                       ask_user), persona (with conversationWindow, model,
 *                       facts), stepScorers, askUserTimeoutMs,
 *                       onUnmatchedAskUser, allowUnreachableReactions
 *   scorers             check, score (number + ScoreResult), toolUsage
 *                       (min/max/path/commandContains/argumentPattern),
 *                       judge (retry, includeToolEvents, input,
 *                       tools + maxRounds + cacheControl)
 *   evaluate            failFast, onScorerError, llm, .fromSnapshot
 *   snapshots           buildRunSnapshot, loadRunSnapshot,
 *                       RUN_SNAPSHOT_VERSION, previewReactions
 *   runtime             setRuntime/resetRuntime, runScorer, runJudgePipeline
 *   capabilities        getAgentCapabilities (per-agent assertions)
 *   exports             DEFAULT_COPY_IGNORE, createLLMClient, createMockLLM
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
    AgentName,
    AgentTransport,
    AskUserQuestion,
    ConversationResult,
    EvalResult,
    Reaction,
    ReactionPreviewResult,
    RunSnapshot,
} from '@wix/pathgrade';
import {
    check,
    createAgent,
    createLLMClient,
    evaluate,
    getAgentCapabilities,
    judge,
    loadRunSnapshot,
    previewReactions,
    runJudgePipeline,
    runScorer,
    score,
    toolUsage,
} from '@wix/pathgrade';

export const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'buggy-calc');
export const HOOK_TIMEOUT_MS = 600_000;

/** Locate the first `run-snapshot.json` anywhere under `rootDir`. */
export function findSnapshotPath(rootDir: string): string {
    const pending = [rootDir];
    while (pending.length > 0) {
        const currentDir = pending.pop();
        if (!currentDir || !fs.existsSync(currentDir)) continue;
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const full = path.join(currentDir, entry.name);
            if (entry.isDirectory()) { pending.push(full); continue; }
            if (entry.isFile() && entry.name === 'run-snapshot.json') return full;
        }
    }
    throw new Error(`Could not find run-snapshot.json under ${rootDir}`);
}

/**
 * Deterministic mock LLM used for every judge and persona call in the suite.
 * Returning a scored JSON object satisfies both simple `judge()` calls and the
 * summarization calls made by `createConversationWindow`.
 */
export function createRegressionJudgeLLM() {
    return createLLMClient({
        adapters: [{
            name: 'regression-mock',
            isAvailable: async () => true,
            call: async (prompt: string) => {
                const foundFix = prompt.includes('return a - b') || /a\s*-\s*b/.test(prompt);
                const verified = /All tests passed|node calc\.test\.js|calc\.test\.js/i.test(prompt);
                const payload = {
                    score: foundFix && verified ? 0.9 : 0.3,
                    reasoning: foundFix && verified
                        ? 'The session shows the subtract fix and explicit test verification.'
                        : 'The session is missing the expected fix details or verification evidence.',
                };
                return {
                    text: JSON.stringify(payload),
                    provider: 'openai' as const,
                    model: 'regression-mock-judge',
                };
            },
        }],
    });
}

export const TEXT_REACTIONS: Reaction[] = [
    {
        when: /found.*bug|identified.*issue|problem.*subtract|subtract.*wrong|subtract.*add|bug.*subtract/i,
        unless: /not sure|uncertain|might be|could be.*multiple/i,
        reply: 'Good catch — the subtract function is wrong. Go ahead and fix it.',
        once: true,
    },
    {
        when: /shall I|should I|want me to|may I|can I|let me/i,
        reply: 'Yes, fix the bug and run calc.test.js to verify.',
        once: true,
    },
    {
        when: /fixed|updated|changed|corrected|edited/i,
        unless: /couldn.t fix|failed to fix|unable|error/i,
        reply: 'Good. Run the tests to confirm everything passes.',
    },
    {
        when: /all tests passed|tests pass|everything passes|tests are passing/i,
        reply: 'Looks good, thanks.',
    },
];

/**
 * Ask-user reaction. Exercise two patterns at once:
 *   - `whenAsked` as a RegExp matching the question text
 *   - `answer` as a function returning a string
 * Harmless on agents with no live ask_user transport — it just never fires
 * (for claude/cursor, it may still fire as post-hoc).
 */
export const ASK_USER_REACTION: Reaction = {
    whenAsked: /proceed|confirm|apply|fix/i,
    answer: (_q: AskUserQuestion) => 'yes, go ahead',
};

export type RegressionRun = {
    // Primary run: runConversation agent
    conversation: ConversationResult;
    liveEval: EvalResult;
    preview: ReactionPreviewResult;
    snapshot: RunSnapshot;
    snapshotReplay: EvalResult;
    // Secondary surfaces
    promptText: string;
    promptTranscript: string;
    chatTurns: number;
    chatHasFile: boolean;
    execStdout: string;
    // Runtime smoke outputs
    standaloneScorer: { score: number; name: string };
    standaloneJudge: { score: number; name: string };
};

export interface RegressionOptions {
    agent: AgentName;
    /** Only meaningful for codex; passed through to createAgent. */
    transport?: AgentTransport;
    /** Debug directory root (per-agent). */
    debugRoot: string;
    /**
     * Include an AskUserReaction. Safe on every agent — on noninteractive
     * transports `allowUnreachableReactions` is set so the preflight
     * still passes.
     */
    includeAskUserReaction?: boolean;
}

export async function runRegression(opts: RegressionOptions): Promise<RegressionRun> {
    fs.rmSync(opts.debugRoot, { recursive: true, force: true });

    const judgeLlm = createRegressionJudgeLLM();

    const capabilities = getAgentCapabilities(opts.agent, opts.transport);
    const transportIsReliable = capabilities.interactiveQuestionTransport === 'reliable';

    const reactions: Reaction[] = opts.includeAskUserReaction
        ? [...TEXT_REACTIONS, ASK_USER_REACTION]
        : [...TEXT_REACTIONS];

    // --- 1. Primary agent: runConversation with the full feature surface ------
    const convAgent = await createAgent({
        agent: opts.agent,
        transport: opts.transport,
        timeout: 'auto',
        workspace: FIXTURE_DIR,
        debug: path.join(opts.debugRoot, 'conversation'),
        copyIgnore: ['node_modules', '.git', 'coverage', '*.log'],
        conversationWindow: { windowSize: 6 },
        env: { PATHGRADE_REGRESSION_MODE: 'sdk-regression' },
    });

    const conversation = await convAgent.runConversation({
        firstMessage:
            'This project has a failing test. Run `node calc.test.js` to see the failure, ' +
            'find the bug in calc.js, fix it, and verify all tests pass.',
        maxTurns: 10,
        reactions,
        persona: {
            description:
                'You are a QA engineer reviewing a calculator bug fix. ' +
                'Give short, direct answers. Focus on test outcomes.',
            facts: [
                'The project has three functions: add, subtract, multiply.',
                'The known bug is in subtract — it returns a+b instead of a-b.',
                'You expect a minimal one-line fix, not a rewrite.',
            ],
            model: 'claude-haiku-4-5-20251001',
            llm: judgeLlm,
            conversationWindow: { windowSize: 4 },
        },
        until: async ({ lastMessage }) => /all tests passed/i.test(lastMessage),
        stepScorers: [
            { afterTurn: 1, scorers: [check('agent-responded', ({ transcript }) => transcript.length > 0)] },
        ],
        askUserTimeoutMs: 30_000,
        onUnmatchedAskUser: 'decline',
        // On noninteractive transports the reactions[] contains an
        // AskUserReaction that can't fire live — silence the guard.
        allowUnreachableReactions: !transportIsReliable,
    });

    // --- 2. Live eval: all four scorer types with advanced options -----------
    const liveEval = await evaluate(convAgent, [
        check('tests-pass', async ({ runCommand }) => {
            const { exitCode } = await runCommand('node calc.test.js');
            return exitCode === 0;
        }, { weight: 2 }),
        score('subtract-correctness', async ({ runCommand }) => {
            const { stdout } = await runCommand(
                'node -e "const c = require(\'./calc\'); console.log(c.subtract(10, 3))"',
            );
            return stdout.trim() === '7' ? { score: 1, details: 'subtract returns 7' } : 0;
        }),
        toolUsage('fix-workflow', [
            { action: 'read_file', min: 1, weight: 0.25 },
            { action: 'edit_file', min: 1, max: 20, path: 'calc.js', weight: 0.5 },
            { action: 'run_shell', min: 1, commandContains: 'calc.test.js', weight: 0.25 },
        ]),
        judge('full-flow-quality', {
            includeToolEvents: true,
            retry: true,
            input: async ({ artifacts }) => ({
                'Expected behavior': 'subtract(a, b) should return a - b',
                'Root cause': 'subtract() returned a + b instead of a - b',
                'calc.js': await artifacts.read('calc.js'),
                'calc.test.js': await artifacts.read('calc.test.js'),
                'touched artifacts': artifacts.list().join('\n'),
            }),
            rubric:
                'Evaluate whether the agent executed the bug-fix flow correctly:\n' +
                '- Did it identify that subtract() returned a + b instead of a - b? (0-0.25)\n' +
                '- Did it make a minimal targeted edit in calc.js? (0-0.25)\n' +
                '- Did it verify the fix by running calc.test.js? (0-0.25)\n' +
                '- Do the touched artifacts show a clean completed fix? (0-0.25)',
        }),
        judge('code-judge-with-tools', {
            tools: ['readFile', 'listDir', 'grep', 'getToolEvents'],
            maxRounds: 4,
            cacheControl: true,
            rubric:
                'Read calc.js, confirm subtract returns a - b, and return 1.0 if so. ' +
                'You may use the provided tools. Return JSON {"score": 0..1, "reasoning": "..."}.',
        }),
    ], {
        failFast: false,
        llm: judgeLlm,
        onScorerError: 'zero',
    });

    // Snapshot the primary run before dispose cleans the workspace.
    await convAgent.dispose();
    const snapshotPath = findSnapshotPath(opts.debugRoot);
    const snapshot = await loadRunSnapshot(snapshotPath);
    const preview = previewReactions(snapshot.messages, reactions);

    // --- 3. Snapshot replay using evaluate.fromSnapshot ----------------------
    const snapshotReplay = await evaluate.fromSnapshot(snapshotPath, [
        check('artifact-helper-lists-edited-file', ({ artifacts }) => {
            return artifacts.list().some((p) => p.endsWith('/calc.js') || p === 'calc.js');
        }),
        check('snapshot-preserves-fix-workflow', ({ toolEvents, transcript }) => {
            const editedCalc = toolEvents.some((e) => {
                const p = e.arguments?.file_path ?? e.arguments?.path;
                return e.action === 'edit_file' && typeof p === 'string' && p.endsWith('/calc.js');
            });
            const reranTests = toolEvents.some((e) => {
                const cmd = e.arguments?.command;
                return e.action === 'run_shell' && typeof cmd === 'string' && cmd.includes('calc.test.js');
            });
            return editedCalc && reranTests && /all tests pass/i.test(transcript);
        }),
    ], { llm: judgeLlm });

    // --- 4. Secondary agent: prompt() + exec() + transcript() ---------------
    const oneShot = await createAgent({
        agent: opts.agent,
        transport: opts.transport,
        timeout: 120,
        workspace: FIXTURE_DIR,
        debug: path.join(opts.debugRoot, 'prompt'),
    });
    const promptText = await oneShot.prompt(
        'Reply with the single word READY (uppercase, no punctuation).',
    );
    const promptTranscript = oneShot.transcript();
    const execResult = await oneShot.exec('node -e "console.log(2+2)"');
    await oneShot.dispose();

    // --- 5. Tertiary agent: startChat() with ChatSession API ----------------
    const chatAgent = await createAgent({
        agent: opts.agent,
        transport: opts.transport,
        timeout: 120,
        workspace: FIXTURE_DIR,
        debug: path.join(opts.debugRoot, 'chat'),
    });
    const chat = await chatAgent.startChat(
        'What file contains the bug? Answer with just the filename.',
    );
    await chat.reply('Thanks. Does calc.js exist in the workspace?');
    const chatHasFile = await chat.hasFile('calc.js');
    chat.end();
    const chatTurns = chat.turn;
    await chatAgent.dispose();

    // --- 6. Runtime surface: runScorer + runJudgePipeline -------------------
    const ctx = {
        workspace: snapshot.workspace ?? '',
        log: snapshot.log,
        transcript: snapshot.messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
        toolEvents: snapshot.toolEvents,
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        artifacts: {
            list: () => [],
            read: async () => '',
            latest: async () => null,
        },
    } as const;

    const standaloneEntry = await runScorer(
        check('standalone-check', () => true),
        ctx,
    );
    const [judgePipelineEntry] = await runJudgePipeline(
        judge('standalone-judge', {
            rubric: 'Return 0.9 if the transcript mentions subtract being wrong, else 0.3.',
        }) as import('@wix/pathgrade').JudgeScorer,
        ctx,
        { llm: judgeLlm },
    );

    return {
        conversation,
        liveEval,
        preview,
        snapshot,
        snapshotReplay,
        promptText,
        promptTranscript,
        chatTurns,
        chatHasFile,
        execStdout: execResult.stdout.trim(),
        standaloneScorer: { score: standaloneEntry.score, name: standaloneEntry.name },
        standaloneJudge: { score: judgePipelineEntry.score, name: judgePipelineEntry.name },
    };
}
