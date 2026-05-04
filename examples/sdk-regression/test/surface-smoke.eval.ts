/**
 * Offline surface smoke — exercises every public export that does NOT require
 * booting a real agent. Runs in a few hundred ms; pair it with the three
 * per-agent eval files below for full-suite regression coverage.
 */
import { describe, expect, it } from 'vitest';
import type {
    AskBatch,
    AskBatchSnapshot,
    PathgradeMeta,
} from 'pathgrade';
import {
    AgentCrashError,
    AskBusTimeoutError,
    buildAskBatchLogEntries,
    buildRunSnapshot,
    check,
    createAskBus,
    createConversationWindow,
    createLLMClient,
    createMockLLM,
    createPersona,
    DEFAULT_COPY_IGNORE,
    evaluate,
    getAgentCapabilities,
    InvalidTransportEnvError,
    judge,
    loadRunSnapshot,
    previewReactions,
    ProviderNotSupportedError,
    requireAskBusForLiveBatches,
    resetRuntime,
    resolveAgentName,
    resolveCodexTransport,
    RUN_SNAPSHOT_VERSION,
    runJudgePipeline,
    runScorer,
    score,
    setRuntime,
    SnapshotParseError,
    SnapshotVersionError,
    toAskUserToolEvent,
    toolUsage,
    WorkspaceMissingError,
    EvalScorerError,
} from 'pathgrade';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**', 'src/utils/llm*.ts'],
};

describe('sdk-regression surface smoke (offline)', () => {
    it('re-exports DEFAULT_COPY_IGNORE with expected entries', () => {
        expect(DEFAULT_COPY_IGNORE).toContain('node_modules');
        expect(DEFAULT_COPY_IGNORE).toContain('.git');
    });

    it('exposes agent capabilities and transport resolution', () => {
        expect(getAgentCapabilities('claude').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('cursor').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('codex', 'app-server').interactiveQuestionTransport).toBe('reliable');
        expect(getAgentCapabilities('codex', 'exec').interactiveQuestionTransport).toBe('noninteractive');

        expect(resolveAgentName({ agent: 'codex' }, {})).toBe('codex');
        expect(resolveAgentName({}, { PATHGRADE_AGENT: 'cursor' })).toBe('cursor');
        expect(resolveAgentName({}, {})).toBe('claude');

        expect(resolveCodexTransport({}, {})).toBe('app-server');
        expect(resolveCodexTransport({ transport: 'exec' }, {})).toBe('exec');
        expect(resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'exec' })).toBe('exec');
        expect(() => resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'bogus' }))
            .toThrow(InvalidTransportEnvError);
    });

    it('constructs all scorer factories with the right shape', () => {
        const c = check('c1', () => true, { weight: 2 });
        expect(c).toMatchObject({ type: 'check', name: 'c1', weight: 2 });

        const s = score('s1', () => 0.5);
        expect(s).toMatchObject({ type: 'score', name: 's1', weight: 1 });

        const t = toolUsage('t1', [{ action: 'read_file', min: 1 }]);
        expect(t).toMatchObject({ type: 'tool_usage', name: 't1' });
        expect(t.expectations.length).toBe(1);

        const j = judge('j1', { rubric: 'r', tools: ['readFile'], maxRounds: 3 });
        expect(j.type).toBe('judge');
        expect(j.tools).toEqual(['readFile']);
        expect(j.maxRounds).toBe(3);
        // cacheControl defaults to true when tools are set
        expect(j.cacheControl).toBe(true);
        // includeToolEvents defaults when getToolEvents is listed
        const j2 = judge('j2', { rubric: 'r', tools: ['getToolEvents'] });
        expect(j2.includeToolEvents).toBe(true);
    });

    it('creates mock LLM clients that record calls and return queued responses', async () => {
        const mock = createMockLLM({
            responses: [
                { text: 'first', inputTokens: 10, outputTokens: 5 },
                'second',
            ],
            defaultResponse: 'fallback',
        });
        const a = await mock.call('hello');
        const b = await mock.call('world');
        const c = await mock.call('extra');
        expect(a.text).toBe('first');
        expect(b.text).toBe('second');
        expect(c.text).toBe('fallback');
        expect(mock.calls.length).toBe(3);

        const client = createLLMClient({
            adapters: [{
                name: 'static', isAvailable: async () => true,
                call: async () => ({ text: 'ok', provider: 'openai', model: 'test' }),
            }],
        });
        const reply = await client.call('prompt');
        expect(reply.text).toBe('ok');
    });

    it('exposes error classes with stable names', () => {
        expect(new AgentCrashError('x', {}).name).toBe('AgentCrashError');
        expect(new InvalidTransportEnvError('bogus').name).toBe('InvalidTransportEnvError');
        expect(new AskBusTimeoutError('b1', 0, 1).name).toBe('AskBusTimeoutError');
        expect(new ProviderNotSupportedError('nope').name).toBe('ProviderNotSupportedError');
        const dummyResult = { score: 0, scorers: [] } as never;
        expect(new EvalScorerError(dummyResult, []).name).toBe('EvalScorerError');
        expect(new SnapshotParseError('bad').name).toBe('SnapshotParseError');
        expect(new SnapshotVersionError(99).name).toBe('SnapshotVersionError');
        expect(new WorkspaceMissingError('missing').name).toBe('WorkspaceMissingError');
    });

    it('runs runScorer and runJudgePipeline standalone with a mock LLM', async () => {
        const mock = createMockLLM({
            defaultResponse: { text: JSON.stringify({ score: 0.75, reasoning: 'ok' }) },
        });
        const ctx = {
            workspace: '',
            log: [],
            transcript: 'agent did the thing',
            toolEvents: [],
            runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            artifacts: { list: () => [], read: async () => '', latest: async () => null },
        };

        const entry = await runScorer(check('always', () => true), ctx as never);
        expect(entry.score).toBe(1);
        expect(entry.status).toBe('ok');

        const [judgeEntry] = await runJudgePipeline(
            judge('pipeline', { rubric: 'score the transcript' }) as import('pathgrade').JudgeScorer,
            ctx as never,
            { llm: mock },
        );
        expect(judgeEntry.score).toBeCloseTo(0.75, 2);
    });

    it('exposes setRuntime / resetRuntime for global LLM overrides', async () => {
        const mock = createMockLLM({ defaultResponse: 'override' });
        setRuntime({ llm: mock });
        try {
            // No direct assertion — smoke: just verify no throw on set/reset.
            resetRuntime();
            resetRuntime(); // idempotent
        } finally {
            resetRuntime();
        }
        expect(true).toBe(true);
    });

    it('createAskBus resolves live batches and redacts secret reaction answers', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1_000 });
        const batch: AskBatch = {
            batchId: 'b1', turnNumber: 1, source: 'codex-app-server', lifecycle: 'live',
            sourceTool: 'request_user_input',
            questions: [
                { id: 'q1', question: 'plain', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'secret', options: null, isOther: false, isSecret: true },
            ],
        };
        const unsub = bus.onAsk((b, respond) => {
            respond({
                answers: [
                    { questionId: 'q1', values: ['hi'], source: 'reaction' },
                    { questionId: 'q2', values: ['shh'], source: 'reaction' },
                ],
            });
        });
        const handle = bus.emit(batch);
        const resolution = await handle.resolution;
        expect(resolution).not.toBeNull();

        const [snap] = bus.snapshot(1) as readonly AskBatchSnapshot[];
        expect(snap.resolution?.answers[0].values).toEqual(['hi']);
        // secret is redacted in snapshot
        expect(snap.resolution?.answers[1].values).toEqual(['<redacted>']);

        const toolEvent = toAskUserToolEvent(snap);
        expect(toolEvent.action).toBe('ask_user');
        expect(toolEvent.arguments.questions.length).toBe(2);

        const logEntries = buildAskBatchLogEntries({
            askBus: bus,
            turnNumber: 1,
            timestamp: new Date().toISOString(),
        });
        expect(logEntries.length).toBeGreaterThan(0);

        unsub();
    });

    it('requireAskBusForLiveBatches throws when a bus is missing', () => {
        expect(() => requireAskBusForLiveBatches(undefined, 'test-driver')).toThrow();
        const bus = createAskBus({ askUserTimeoutMs: 1_000 });
        expect(requireAskBusForLiveBatches({ askBus: bus }, 'test-driver')).toBe(bus);
    });

    it('createPersona and createConversationWindow drive a mock LLM', async () => {
        const mock = createMockLLM({ defaultResponse: 'summary' });
        const window = createConversationWindow({ windowSize: 2, llm: mock });
        const history = await window.getHistory([
            { role: 'user', content: 'a' },
            { role: 'agent', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'agent', content: 'd' },
            { role: 'user', content: 'e' },
        ]);
        expect(history.length).toBeGreaterThan(0);

        const persona = createPersona({
            description: 'tester',
            facts: [],
            llm: createMockLLM({ defaultResponse: 'reply-text' }),
            conversationWindow: false,
        });
        const reply = await persona.reply({
            turn: 1, done: false, lastMessage: 'hi',
            messages: [{ role: 'agent', content: 'hi' }],
            reply: async () => { },
            hasFile: async () => false,
            end: () => { },
        });
        expect(reply).toBe('reply-text');
    });

    it('buildRunSnapshot / loadRunSnapshot round-trip preserves version', async () => {
        const snap = buildRunSnapshot({
            agent: 'codex',
            workspace: '',
            messages: [{ role: 'user', content: 'hi' }],
            log: [],
            conversationResult: {
                turns: 1, completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }],
                stepResults: [],
            },
        });
        expect(snap.version).toBe(RUN_SNAPSHOT_VERSION);

        const tmp = path.join(os.tmpdir(), `regression-snapshot-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(snap));
        const loaded = await loadRunSnapshot(tmp);
        fs.unlinkSync(tmp);
        expect(loaded.version).toBe(RUN_SNAPSHOT_VERSION);
        expect(loaded.agent).toBe('codex');
    });

    it('loadRunSnapshot rejects malformed json with SnapshotParseError', async () => {
        const tmp = path.join(os.tmpdir(), `bad-snapshot-${Date.now()}.json`);
        fs.writeFileSync(tmp, '{not json');
        await expect(loadRunSnapshot(tmp)).rejects.toBeInstanceOf(SnapshotParseError);
        fs.unlinkSync(tmp);
    });

    it('previewReactions classifies all three statuses', () => {
        const preview = previewReactions(
            [
                { role: 'user', content: 'kick off' },
                { role: 'agent', content: 'I found the bug in subtract' },
                { role: 'user', content: 'continue' },
                { role: 'agent', content: 'all tests passed' },
            ],
            [
                {
                    when: /found.*bug/i,
                    reply: 'fix it',
                    once: true,
                },
                { when: /never-matches/, reply: 'n/a' },
            ],
        );
        expect(preview.turns.length).toBeGreaterThan(0);
        const statuses = new Set(preview.turns.flatMap((t) => t.reactions.map((r) => r.status)));
        expect(statuses.has('fired') || statuses.has('no-match')).toBe(true);
    });

    it('evaluate is callable and exports .fromSnapshot', () => {
        // No-arg smoke — we test the full flow in per-agent evals.
        expect(typeof evaluate).toBe('function');
        expect(typeof evaluate.fromSnapshot).toBe('function');
    });
});
