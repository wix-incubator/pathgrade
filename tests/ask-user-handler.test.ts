import { describe, expect, it } from 'vitest';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import { createAskUserHandler } from '../src/sdk/ask-bus/handler.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';
import type { Reaction } from '../src/sdk/types.js';

function makeBatch(overrides: Partial<AskBatch> = {}): AskBatch {
    return {
        batchId: 'batch-1',
        turnNumber: 1,
        source: 'codex-app-server',
        lifecycle: 'live',
        sourceTool: 'request_user_input',
        questions: [
            {
                id: 'q1',
                question: 'Which region?',
                options: null,
                isOther: false,
                isSecret: false,
            },
        ],
        ...overrides,
    };
}

describe('createAskUserHandler — live batches', () => {
    it('single matching reaction resolves single-question live batch', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'us-east-1' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({
            reactions,
            onUnmatchedAskUser: 'error',
            firedOnce: new Set<number>(),
        });
        bus.onAsk(api.handler);

        const handle = bus.emit(makeBatch());
        const resolution = await handle.resolution;

        expect(resolution).not.toBeNull();
        expect(resolution!.answers).toEqual([
            { questionId: 'q1', values: ['us-east-1'], source: 'reaction' },
        ]);
    });

    it('legacy text reactions resolve matching structured ask_user questions', async () => {
        const reactions: Reaction[] = [
            { when: /figma/i, reply: 'Skip' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({
            reactions,
            onUnmatchedAskUser: 'error',
            firedOnce: new Set<number>(),
        });
        bus.onAsk(api.handler);

        const resolution = await bus.emit(makeBatch({
            questions: [
                {
                    id: 'q1',
                    question: "Paste the Figma file URL. If none, pick 'Skip'.",
                    options: [{ label: 'Skip' }],
                    isOther: false,
                    isSecret: false,
                },
            ],
        })).resolution;

        expect(resolution!.answers).toEqual([
            { questionId: 'q1', values: ['Skip'], source: 'reaction' },
        ]);
        expect(api.getUnmatchedError()).toBeNull();
    });

    it('legacy text reaction once:true is retired after answering a structured question', async () => {
        const reactions: Reaction[] = [
            { when: /./, reply: 'first', once: true },
            { when: /./, reply: 'second' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({
            reactions,
            onUnmatchedAskUser: 'error',
            firedOnce: new Set<number>(),
        });
        bus.onAsk(api.handler);

        const batch = makeBatch({
            questions: [
                { id: 'q1', question: 'First question?', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'Second question?', options: null, isOther: false, isSecret: false },
            ],
        });
        const resolution = await bus.emit(batch).resolution;

        expect(resolution!.answers.map((a) => a.values)).toEqual([['first'], ['second']]);
    });

    it('bare string answer normalizes to [string]', async () => {
        const reactions: Reaction[] = [{ whenAsked: /.*/, answer: 'x' }];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch()).resolution;
        expect(resolution!.answers[0].values).toEqual(['x']);
    });

    it('string[] answer passes through', async () => {
        const reactions: Reaction[] = [{ whenAsked: /.*/, answer: ['a', 'b'] }];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch()).resolution;
        expect(resolution!.answers[0].values).toEqual(['a', 'b']);
    });

    it('function answer returning undefined falls through to next matching reaction', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: () => undefined },
            { whenAsked: /region/, answer: 'eu-west-1' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch()).resolution;
        expect(resolution!.answers[0].values).toEqual(['eu-west-1']);
    });

    it('reaction function throw propagates', () => {
        const err = new Error('boom');
        const reactions: Reaction[] = [
            { whenAsked: /.*/, answer: () => { throw err; } },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        // Install directly so the thrown error isn't swallowed by bus handler try/catch
        expect(() => api.handler(makeBatch(), () => {})).toThrow(err);
        // Avoid unhandled rejection from emitted batch
        bus.onAsk(() => {});
    });

    it('multi-question batch: each question answered independently; first reaction wins', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'us-east-1' },
            { whenAsked: /env/, answer: 'prod' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);

        const batch = makeBatch({
            questions: [
                { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'Which env?', options: null, isOther: false, isSecret: false },
            ],
        });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution!.answers).toEqual([
            { questionId: 'q1', values: ['us-east-1'], source: 'reaction' },
            { questionId: 'q2', values: ['prod'], source: 'reaction' },
        ]);
    });

    it('once:true retires a reaction after firing on any question within a batch', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /./, answer: 'first', once: true },
            { whenAsked: /./, answer: 'catch' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({
            questions: [
                { id: 'q1', question: 'a', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'b', options: null, isOther: false, isSecret: false },
            ],
        });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution!.answers.map((a) => a.values)).toEqual([['first'], ['catch']]);
    });

    it('multiple reactions match the same question: first declared wins; later marked shadowed in preview', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'winner' },
            { whenAsked: /region/, answer: 'loser' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch()).resolution;
        expect(resolution!.answers[0].values).toEqual(['winner']);

        const entries = api.previewByBatch.get('batch-1');
        expect(entries).toBeDefined();
        expect(entries!.map((e) => ({ idx: e.reactionIndex, status: e.status }))).toEqual([
            { idx: 0, status: 'fired' },
            { idx: 1, status: 'shadowed' },
        ]);
    });

    it('fallback error: no matching reaction → respond declined + unmatched signal carries batchId/turnNumber', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch({ batchId: 'batch-err', turnNumber: 4 })).resolution;
        expect(resolution!.answers[0]).toEqual({
            questionId: 'q1',
            values: [],
            source: 'declined',
        });
        expect(api.getUnmatchedError()).toEqual({
            batchId: 'batch-err',
            turnNumber: 4,
            questionTexts: ['Which region?'],
        });
    });

    it('unmatched signal carries every question text on the live batch', async () => {
        // Structured unmatched signals must include the question text(s) so
        // completion details and downstream tooling can surface what the
        // agent actually asked, not just the batch id.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({
            batchId: 'batch-multi',
            turnNumber: 2,
            questions: [
                { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'Which env?', options: null, isOther: false, isSecret: false },
            ],
        });
        await bus.emit(batch).resolution;
        expect(api.getUnmatchedError()).toEqual({
            batchId: 'batch-multi',
            turnNumber: 2,
            questionTexts: ['Which region?', 'Which env?'],
        });
    });

    it("fallback first-option: picks options[0].label when options present and non-secret", async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'first-option', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({
            questions: [
                {
                    id: 'q1',
                    question: 'Which region?',
                    options: [{ label: 'us-east-1' }, { label: 'eu-west-1' }],
                    isOther: false,
                    isSecret: false,
                },
            ],
        });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution!.answers[0]).toEqual({
            questionId: 'q1',
            values: ['us-east-1'],
            source: 'fallback',
        });
        expect(api.getUnmatchedError()).toBeNull();
    });

    it('fallback first-option: free-text question (options=null) degrades to error', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'first-option', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch({ batchId: 'ft' })).resolution;
        expect(resolution!.answers[0].values).toEqual([]);
        expect(resolution!.answers[0].source).toBe('declined');
        expect(api.getUnmatchedError()).toEqual({
            batchId: 'ft',
            turnNumber: 1,
            questionTexts: ['Which region?'],
        });
    });

    it('fallback first-option: isSecret question degrades to error (never fabricates secrets)', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'first-option', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({
            batchId: 'sec',
            questions: [
                {
                    id: 'q1',
                    question: 'Password?',
                    options: [{ label: 'hunter2' }],
                    isOther: false,
                    isSecret: true,
                },
            ],
        });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution!.answers[0]).toEqual({ questionId: 'q1', values: [], source: 'declined' });
        expect(api.getUnmatchedError()).toEqual({
            batchId: 'sec',
            turnNumber: 1,
            questionTexts: ['Password?'],
        });
    });

    it('fallback decline: emits empty values without signalling unmatched error', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'decline', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const resolution = await bus.emit(makeBatch()).resolution;
        expect(resolution!.answers[0]).toEqual({ questionId: 'q1', values: [], source: 'declined' });
        expect(api.getUnmatchedError()).toBeNull();
    });

    it('whenAsked as a function receives question and gates match', async () => {
        const reactions: Reaction[] = [
            { whenAsked: (q) => q.id === 'q2', answer: 'only-q2' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'decline', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({
            questions: [
                { id: 'q1', question: 'a', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'b', options: null, isOther: false, isSecret: false },
            ],
        });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution!.answers.map((a) => [a.questionId, a.values, a.source])).toEqual([
            ['q1', [], 'declined'],
            ['q2', ['only-q2'], 'reaction'],
        ]);
    });
});

describe('createAskUserHandler — post-hoc batches', () => {
    it('records preview entries but does not respond (resolution is null)', async () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'us-east-1' },
        ];
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions, onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        const batch = makeBatch({ lifecycle: 'post-hoc', batchId: 'ph-1' });
        const resolution = await bus.emit(batch).resolution;
        expect(resolution).toBeNull();

        const entries = api.previewByBatch.get('ph-1');
        expect(entries).toBeDefined();
        expect(entries![0]).toMatchObject({
            kind: 'ask_user',
            reactionIndex: 0,
            fired: true,
            status: 'fired',
            resolvedAnswers: ['us-east-1'],
        });
        expect(api.getUnmatchedError()).toBeNull();
    });

    it('post-hoc fallback error does NOT signal unmatchedError (live-only signal)', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const api = createAskUserHandler({ reactions: [], onUnmatchedAskUser: 'error', firedOnce: new Set() });
        bus.onAsk(api.handler);
        await bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'ph-err' })).resolution;
        expect(api.getUnmatchedError()).toBeNull();
    });
});
