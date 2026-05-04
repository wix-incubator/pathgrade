import { describe, it, expect } from 'vitest';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import { buildAskBatchLogEntries } from '../src/sdk/agent-result-log.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';

function liveBatch(turnNumber: number, batchId: string): AskBatch {
    return {
        batchId,
        turnNumber,
        source: 'codex-app-server',
        lifecycle: 'live',
        sourceTool: 'request_user_input',
        toolUseId: batchId,
        questions: [
            { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
        ],
    };
}

function postHocBatch(turnNumber: number, batchId: string): AskBatch {
    return {
        batchId,
        turnNumber,
        source: 'claude',
        lifecycle: 'post-hoc',
        sourceTool: 'AskUserQuestion',
        questions: [
            { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
            { id: 'q2', question: 'Which env?', options: null, isOther: false, isSecret: false },
        ],
    };
}

describe('buildAskBatchLogEntries', () => {
    it('returns empty array when bus has no batches for the turn', () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const entries = buildAskBatchLogEntries({
            askBus: bus,
            turnNumber: 1,
            timestamp: '2026-04-24T00:00:00.000Z',
        });
        expect(entries).toEqual([]);
    });

    it('emits one ask_batch LogEntry per batch in the turn, with the correct fields', () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.emit(postHocBatch(1, 'bp-1'));
        bus.emit(postHocBatch(2, 'bp-2')); // different turn — excluded

        const entries = buildAskBatchLogEntries({
            askBus: bus,
            turnNumber: 1,
            timestamp: '2026-04-24T00:00:00.000Z',
        });

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            type: 'ask_batch',
            timestamp: '2026-04-24T00:00:00.000Z',
            turn_number: 1,
            batch_id: 'bp-1',
            source: 'claude',
            lifecycle: 'post-hoc',
            source_tool: 'AskUserQuestion',
            question_count: 2,
        });
    });

    it("includes resolved:true for live batches that have a resolution; resolved field absent for post-hoc", async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            if (batch.lifecycle === 'live') {
                respond({
                    answers: [{ questionId: 'q1', values: ['us-east-1'], source: 'reaction' }],
                });
            }
        });

        bus.emit(postHocBatch(3, 'claude-bp'));
        const liveHandle = bus.emit(liveBatch(3, 'live-1'));
        await liveHandle.resolution;

        const entries = buildAskBatchLogEntries({
            askBus: bus,
            turnNumber: 3,
            timestamp: '2026-04-24T00:00:00.000Z',
        });

        expect(entries).toHaveLength(2);
        const postHoc = entries.find((e) => e.lifecycle === 'post-hoc')!;
        const live = entries.find((e) => e.lifecycle === 'live')!;

        expect(postHoc).not.toHaveProperty('resolved');
        expect(live.resolved).toBe(true);
    });

    it('carries tool_use_id when present on the batch', () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.emit(liveBatch(5, 'live-5'));

        const entries = buildAskBatchLogEntries({
            askBus: bus,
            turnNumber: 5,
            timestamp: '2026-04-24T00:00:00.000Z',
        });

        expect(entries[0].tool_use_id).toBe('live-5');
    });
});
