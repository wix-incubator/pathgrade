/**
 * SDK Showcase (Claude) — a real shared-run eval that demonstrates the main SDK surfaces.
 *
 * This example keeps one live agent conversation, then validates the run in a
 * few focused tests the same way a production eval suite would.
 *
 * Features demonstrated:
 *   createAgent      — debug, copyIgnore, timeout:'auto', conversationWindow, env
 *   runConversation  — reactions (when/unless/once), persona fallback, until, maxTurns, stepScorers
 *   evaluate         — all 4 scorer types (check, score, judge, toolUsage), failFast, onScorerError
 *   judge            — retry, includeToolEvents, artifact-backed async input
 *   results          — tokenUsage, scorer status
 *   snapshots        — loadRunSnapshot, evaluate.fromSnapshot, previewReactions
 *   new branch bits  — runtime policy metadata and artifact helper usage
 *   exports          — DEFAULT_COPY_IGNORE
 *
 * Run: npx vitest run --config examples/sdk-showcase/vitest.config.mts
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type {
    ConversationResult,
    EvalResult,
    PathgradeMeta,
    Reaction,
    ReactionPreviewResult,
    RunSnapshot,
} from '@wix/pathgrade';
import {
    check,
    createAgent,
    DEFAULT_COPY_IGNORE,
    evaluate,
    judge,
    loadRunSnapshot,
    previewReactions,
    score,
    toolUsage,
    createLLMClient,
} from '@wix/pathgrade';

/** Re-run when SDK source changes, not just when example files change. */
export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**'],
};

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'buggy-calc');
const DEBUG_ROOT = path.join(__dirname, 'pathgrade-debug-claude');
const hookTimeoutMs = 300_000;
const SHOWCASE_AGENT = 'claude' as const;

const REACTIONS: Reaction[] = [
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

type ShowcaseRun = {
    conversation: ConversationResult;
    liveEval: EvalResult;
    preview: ReactionPreviewResult;
    snapshot: RunSnapshot;
    snapshotReplay: EvalResult;
};

let showcaseRunPromise: Promise<ShowcaseRun> | null = null;

function createShowcaseJudgeLLM() {
    return createLLMClient({
        adapters: [{
            name: 'showcase-mock',
            isAvailable: async () => true,
            call: async (prompt: string) => {
                const foundFix = prompt.includes('return a - b');
                const verifiedTests = /All tests passed|node calc\.test\.js|calc\.test\.js/i.test(prompt);
                const score = foundFix && verifiedTests ? 0.9 : 0.2;

                return {
                    text: JSON.stringify({
                        score,
                        reasoning: foundFix && verifiedTests
                            ? 'The session shows the subtract fix and explicit test verification.'
                            : 'The session is missing the expected fix details or verification evidence.',
                    }),
                    provider: 'openai' as const,
                    model: 'showcase-mock-judge',
                };
            },
        }],
    });
}

function findSnapshotPath(rootDir: string): string {
    const pending = [rootDir];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        if (!currentDir || !fs.existsSync(currentDir)) {
            continue;
        }

        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                pending.push(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name === 'run-snapshot.json') {
                return fullPath;
            }
        }
    }

    throw new Error(`Could not find run-snapshot.json under ${rootDir}`);
}

async function getShowcaseRun(): Promise<ShowcaseRun> {
    if (showcaseRunPromise) {
        return showcaseRunPromise;
    }

    showcaseRunPromise = (async () => {
        fs.rmSync(DEBUG_ROOT, { recursive: true, force: true });
        const judgeLlm = createShowcaseJudgeLLM();

        const agent = await createAgent({
            agent: SHOWCASE_AGENT,
            timeout: 'auto',
            workspace: FIXTURE_DIR,
            debug: DEBUG_ROOT,
            copyIgnore: ['node_modules', '.git', 'coverage', '*.log'],
            conversationWindow: { windowSize: 6 },
            env: { PATHGRADE_SHOWCASE_MODE: 'sdk-showcase' },
        });

        const conversation = await agent.runConversation({
            firstMessage:
                'This project has a failing test. Run `node calc.test.js` to see the failure, ' +
                'find the bug in calc.js, fix it, and verify all tests pass.',
            maxTurns: 10,
            reactions: REACTIONS,
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
                conversationWindow: { windowSize: 4 },
            },
            until: async ({ lastMessage }) => /all tests passed/i.test(lastMessage),
            stepScorers: [
                {
                    afterTurn: 1,
                    scorers: [
                        check('agent-responded', ({ transcript }) => transcript.length > 0),
                    ],
                },
            ],
        });

        const liveEval = await evaluate(agent, [
            check('tests-pass', async ({ runCommand }) => {
                const { exitCode } = await runCommand('node calc.test.js');
                return exitCode === 0;
            }, { weight: 2 }),
            score('subtract-correctness', async ({ runCommand }) => {
                const { stdout } = await runCommand(
                    'node -e "const c = require(\'./calc\'); console.log(c.subtract(10, 3))"',
                );
                return stdout.trim() === '7' ? 1.0 : 0.0;
            }),
            toolUsage('fix-workflow', [
                { action: 'read_file', min: 1, weight: 0.3 },
                { action: 'edit_file', min: 1, weight: 0.4 },
                { action: 'run_shell', min: 1, weight: 0.3 },
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
                    '- Did it make a minimal targeted edit in calc.js instead of rewriting the module? (0-0.25)\n' +
                    '- Did it verify the fix by running calc.test.js? (0-0.25)\n' +
                    '- Do the touched artifacts and final files show a clean completed fix? (0-0.25)',
            }),
        ], {
            failFast: false,
            llm: judgeLlm,
            onScorerError: 'zero',
        });

        await agent.dispose();

        const snapshotPath = findSnapshotPath(DEBUG_ROOT);
        const snapshot = await loadRunSnapshot(snapshotPath);
        const preview = previewReactions(snapshot.messages, REACTIONS);

        const snapshotReplay = await evaluate.fromSnapshot(snapshotPath, [
            // Slice #004 flipped Claude to `interactiveQuestionTransport: 'reliable'`
            // and `planRuntimePolicies('claude')` returns `[]`, so the legacy
            // noninteractive-user-question policy must NEVER appear on the
            // Claude path. Codex/Cursor still emit it; this scorer is the
            // Claude-specific inverse.
            check('reliable-transport-no-runtime-policy', ({ log }) =>
                !log.some((entry) =>
                    entry.runtime_policies_applied?.some(
                        (policy) => policy.id === 'noninteractive-user-question',
                    ),
                ),
            ),
            check('artifact-helper-lists-edited-file', ({ artifacts }) => {
                const touched = artifacts.list();
                return touched.some((artifactPath) => artifactPath.endsWith('/calc.js') || artifactPath === 'calc.js');
            }),
            check('snapshot-preserves-fix-workflow', ({ toolEvents, transcript }) => {
                const editedCalc = toolEvents.some(
                    (event) => {
                        const eventPath = event.arguments?.file_path ?? event.arguments?.path;
                        return event.action === 'edit_file'
                            && typeof eventPath === 'string'
                            && eventPath.endsWith('/calc.js');
                    },
                );
                const reranTests = toolEvents.some(
                    (event) => {
                        const command = event.arguments?.command;
                        return event.action === 'run_shell'
                            && typeof command === 'string'
                            && command.includes('calc.test.js');
                    },
                );

                return editedCalc && reranTests && /all tests pass/i.test(transcript);
            }),
        ], { llm: judgeLlm });

        return {
            conversation,
            liveEval,
            preview,
            snapshot,
            snapshotReplay,
        };
    })();

    return showcaseRunPromise;
}

describe('sdk-showcase (claude): shared bugfix flow', () => {
    it('completes a real bug-fix conversation with healthy scoring', async () => {
        const { conversation, liveEval } = await getShowcaseRun();

        expect(DEFAULT_COPY_IGNORE).toContain('node_modules');
        expect(DEFAULT_COPY_IGNORE).toContain('.git');
        expect(conversation.turns).toBeGreaterThanOrEqual(1);
        expect(conversation.turnTimings.length).toBe(conversation.turns);
        if (conversation.turnDetails) {
            expect(conversation.turnDetails[0]).toHaveProperty('outputLines');
            expect(conversation.turnDetails[0]).toHaveProperty('outputChars');
        }
        if (conversation.reactionsFired && conversation.reactionsFired.length > 0) {
            expect(conversation.reactionsFired[0]).toHaveProperty('pattern');
        }
        if (conversation.stepResults.length > 0) {
            expect(conversation.stepResults[0].afterTurn).toBe(1);
            expect(conversation.stepResults[0].result.score).toBeDefined();
        }

        expect(liveEval.score).toBeGreaterThan(0);
        expect(liveEval.tokenUsage).toBeDefined();
        for (const scorer of liveEval.scorers) {
            expect(['ok', 'error', 'skipped']).toContain(scorer.status);
        }
    }, hookTimeoutMs);

    it('captures the run as a snapshot and previews reactions offline', async () => {
        const { conversation, preview, snapshot } = await getShowcaseRun();

        expect(snapshot.version).toBe(1);
        expect(snapshot.agent).toBe(SHOWCASE_AGENT);
        expect(snapshot.messages.length).toBeGreaterThan(0);
        expect(snapshot.toolEvents.length).toBeGreaterThan(0);
        expect(snapshot.turnTimings.length).toBe(conversation.turns);
        expect(snapshot.conversationResult.turns).toBe(conversation.turns);
        expect(snapshot.conversationResult.completionReason).toBe(conversation.completionReason);
        // Reliable transport (post-#004) — no runtime policy emitted.
        expect(
            snapshot.log.some((entry) =>
                entry.runtime_policies_applied?.some(
                    (policy) => policy.id === 'noninteractive-user-question',
                ),
            ),
        ).toBe(false);

        expect(preview.turns.length).toBeGreaterThan(0);
        for (const turn of preview.turns) {
            expect(turn.agentMessage).toBeTruthy();
            for (const reaction of turn.reactions) {
                expect(['fired', 'vetoed', 'no-match']).toContain(reaction.status);
            }
        }
    }, hookTimeoutMs);

    it('replays the snapshot with runtime policy and artifact helper checks', async () => {
        const { snapshotReplay } = await getShowcaseRun();
        expect(snapshotReplay.score).toBe(1);
        expect(snapshotReplay.tokenUsage).toBeDefined();
    }, hookTimeoutMs);

    it('judges the full bug-fix flow using artifact-backed input', async () => {
        const { liveEval } = await getShowcaseRun();
        const judgeScorer = liveEval.scorers.find((scorer) => scorer.name === 'full-flow-quality');
        expect(judgeScorer).toBeDefined();
        expect(judgeScorer?.status).toBe('ok');
        expect(judgeScorer?.score).toBeGreaterThanOrEqual(0.5);
    }, hookTimeoutMs);
});
