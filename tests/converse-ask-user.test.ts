import { describe, it, expect } from 'vitest';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';
import type { Message } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
    return {
        sendTurn: async () => 'default response',
        hasFile: async () => false,
        workspace: '/tmp/test',
        messages: [] as Message[],
        log: [] as LogEntry[],
        ...overrides,
    };
}

const liveBatch: AskBatch = {
    batchId: 'batch-xyz',
    turnNumber: 1,
    source: 'codex-app-server',
    lifecycle: 'live',
    sourceTool: 'request_user_input',
    questions: [
        { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
    ],
};

describe('runConversation: onAsk subscription', () => {
    it('resolves a live ask_user batch via a matching AskUserReaction (no new completionReason)', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const messages: Message[] = [];
        const log: LogEntry[] = [];

        let emitHandlePromise: Promise<unknown> | null = null;

        // Simulate a driver that emits a live batch on turn 1 and waits for resolution.
        const sendTurn = async () => {
            if (!emitHandlePromise) {
                const handle = askBus.emit(liveBatch);
                emitHandlePromise = handle.resolution;
                await emitHandlePromise;
            }
            return 'done';
        };

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ whenAsked: /region/, answer: 'us-east-1' }],
                maxTurns: 1,
            },
            makeDeps({ sendTurn, messages, log, askBus }),
        );

        // Batch was resolved via the reaction
        const resolution = await emitHandlePromise;
        expect(resolution).not.toBeNull();
        expect((resolution as unknown as { answers: Array<{ values: string[] }> }).answers[0].values).toEqual(['us-east-1']);

        // Conversation completes without new completionReason members
        expect(result.completionReason).toBe('maxTurns');
    });

    it('unmatched live ask_user under default onUnmatchedAskUser=error ends with completionReason=error and completionDetail naming batch', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });

        let emitted = false;
        const sendTurn = async () => {
            if (!emitted) {
                emitted = true;
                const handle = askBus.emit({ ...liveBatch, batchId: 'batch-err', turnNumber: 1 });
                await handle.resolution;
            }
            return 'agent keeps going';
        };

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [],
                maxTurns: 3,
            },
            makeDeps({ sendTurn, askBus }),
        );

        expect(result.completionReason).toBe('error');
        expect(result.completionDetail).toMatch(/unmatched ask_user on turn 1: batch-err/);
    });

    it('fallback=decline keeps the conversation alive (no unmatched error)', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        let emitted = false;
        const sendTurn = async (message: string) => {
            if (!emitted) {
                emitted = true;
                const handle = askBus.emit(liveBatch);
                await handle.resolution;
                return 'first-turn output';
            }
            return `echoed: ${message}`;
        };

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'keep going' }],
                onUnmatchedAskUser: 'decline',
                maxTurns: 2,
            },
            makeDeps({ sendTurn, askBus }),
        );

        expect(result.completionReason).toBe('maxTurns');
    });

    it('post-hoc batches do NOT produce completionReason=error even with fallback=error', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const sendTurn = async () => {
            askBus.emit({ ...liveBatch, batchId: 'ph-1', lifecycle: 'post-hoc' });
            return 'agent text';
        };

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'ok' }],
                maxTurns: 1,
            },
            makeDeps({ sendTurn, askBus }),
        );

        // post-hoc without a matching ask-user reaction does not stall the
        // conversation since nothing is waiting on the bus handle.
        expect(result.completionReason).toBe('maxTurns');
    });
});
