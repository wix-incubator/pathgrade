import { describe, it, expect, vi } from 'vitest';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AskBatch, AskResolution } from '../src/sdk/ask-bus/types.js';

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

describe('createAskBus', () => {
    it('emit + onAsk single subscriber live: resolves via respond', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: ['us-east-1'], source: 'reaction' }],
            });
        });

        const handle = bus.emit(makeBatch());
        const resolution = await handle.resolution;

        expect(resolution).not.toBeNull();
        expect(resolution!.answers).toEqual([
            { questionId: 'q1', values: ['us-east-1'], source: 'reaction' },
        ]);
    });

    it('emit + onAsk multi-subscriber live: first respond wins; later calls logged and dropped', async () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const bus = createAskBus({ askUserTimeoutMs: 1000 });

        bus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: ['first'], source: 'reaction' }],
            });
        });
        bus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: ['second'], source: 'reaction' }],
            });
        });

        const handle = bus.emit(makeBatch());
        const resolution = await handle.resolution;

        expect(resolution!.answers[0].values).toEqual(['first']);
        expect(debugSpy).toHaveBeenCalled();
        debugSpy.mockRestore();
    });

    it('emit live with no subscriber: handle.resolution rejects after askUserTimeoutMs with batchId + turnNumber in error', async () => {
        vi.useFakeTimers();
        const bus = createAskBus({ askUserTimeoutMs: 30 });
        const handle = bus.emit(makeBatch({ batchId: 'batch-xyz', turnNumber: 7 }));

        const errorPromise = handle.resolution.catch((err) => err);
        await vi.advanceTimersByTimeAsync(31);
        const err = await errorPromise as Error & { batchId?: string; turnNumber?: number };

        expect(err).toBeInstanceOf(Error);
        expect(err.batchId).toBe('batch-xyz');
        expect(err.turnNumber).toBe(7);
        vi.useRealTimers();
    });

    it('emit post-hoc: subscriber observes; resolves to null synchronously; respond populates snapshot but not wire; dev-warning emitted once', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const observed: AskBatch[] = [];

        bus.onAsk((batch, respond) => {
            observed.push(batch);
            respond({
                answers: [{ questionId: 'q1', values: ['observed'], source: 'fallback' }],
            });
        });

        const batch = makeBatch({ lifecycle: 'post-hoc', batchId: 'post-1' });
        const handle = bus.emit(batch);

        await expect(handle.resolution).resolves.toBeNull();
        expect(observed).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/post-hoc/i);

        const snap = bus.snapshot();
        expect(snap).toHaveLength(1);
        expect(snap[0].resolution).not.toBeNull();
        expect(snap[0].resolution!.answers[0].values).toEqual(['observed']);

        warnSpy.mockRestore();
    });

    it('snapshot redaction: isSecret + source=reaction yields [\'<redacted>\']; handle.resolution carries raw values', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: ['secret-value'], source: 'reaction' }],
            });
        });

        const batch = makeBatch({
            questions: [
                {
                    id: 'q1',
                    question: 'Password?',
                    options: null,
                    isOther: false,
                    isSecret: true,
                },
            ],
        });
        const handle = bus.emit(batch);
        const resolution = await handle.resolution;
        expect(resolution!.answers[0].values).toEqual(['secret-value']);

        const snap = bus.snapshot();
        expect(snap[0].resolution!.answers[0].values).toEqual(['<redacted>']);
    });

    it('snapshot redaction: isSecret + source=fallback also redacts defensively', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: ['leaked'], source: 'fallback' }],
            });
        });
        const batch = makeBatch({
            lifecycle: 'post-hoc',
            questions: [
                { id: 'q1', question: 'Secret?', options: null, isOther: false, isSecret: true },
            ],
        });
        bus.emit(batch);

        const snap = bus.snapshot();
        expect(snap[0].resolution!.answers[0].values).toEqual(['<redacted>']);
    });

    it('snapshot redaction: source=declined renders empty values as-is', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 'q1', values: [], source: 'declined' }],
            });
        });
        const batch = makeBatch({
            lifecycle: 'post-hoc',
            questions: [
                { id: 'q1', question: 'Secret?', options: null, isOther: false, isSecret: true },
            ],
        });
        bus.emit(batch);
        const snap = bus.snapshot();
        expect(snap[0].resolution!.answers[0].values).toEqual([]);
        expect(snap[0].resolution!.answers[0].source).toBe('declined');
    });

    it('snapshot filtering by turnNumber', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'a', turnNumber: 1 }));
        bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'b', turnNumber: 2 }));
        bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'c', turnNumber: 2 }));

        expect(bus.snapshot().map((s) => s.batchId)).toEqual(['a', 'b', 'c']);
        expect(bus.snapshot(2).map((s) => s.batchId)).toEqual(['b', 'c']);
        expect(bus.snapshot(1).map((s) => s.batchId)).toEqual(['a']);
    });

    it('unsubscribe detaches the handler', () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const calls: AskBatch[] = [];
        const unsub = bus.onAsk((batch) => {
            calls.push(batch);
        });

        bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'a' }));
        unsub();
        bus.emit(makeBatch({ lifecycle: 'post-hoc', batchId: 'b' }));

        expect(calls.map((c) => c.batchId)).toEqual(['a']);
    });

    it('post-hoc handle.resolution is synchronous (resolves before next microtask tick)', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const handle = bus.emit(makeBatch({ lifecycle: 'post-hoc' }));
        let resolvedValue: AskResolution | null | 'pending' = 'pending';
        handle.resolution.then((v) => {
            resolvedValue = v;
        });
        await Promise.resolve();
        expect(resolvedValue).toBeNull();
    });
});
