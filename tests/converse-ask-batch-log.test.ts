import { describe, it, expect } from 'vitest';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AgentTurnResult, LogEntry } from '../src/types.js';
import type { Message } from '../src/sdk/types.js';

function makeTurnResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
    return {
        rawOutput: 'ok',
        assistantMessage: 'ok',
        visibleAssistantMessage: 'ok',
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        blockedPrompts: [],
        toolEvents: [],
        ...overrides,
    };
}

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
    return {
        sendTurn: async () => 'ok',
        hasFile: async () => false,
        workspace: '/tmp/test',
        messages: [] as Message[],
        log: [] as LogEntry[],
        ...overrides,
    };
}

describe('runConversation — ask_batch log entries dual-written alongside agent_result', () => {
    it('pushes one ask_batch LogEntry per batch emitted during the turn, before the agent_result entry', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const log: LogEntry[] = [];

        // Simulate a Claude post-hoc emission that happens during sendTurn (adapter
        // emits into the bus before returning the turn result).
        const sendTurn = async (): Promise<AgentTurnResult> => {
            bus.emit({
                batchId: 'bp-1',
                turnNumber: 1,
                source: 'claude',
                lifecycle: 'post-hoc',
                sourceTool: 'AskUserQuestion',
                questions: [
                    { id: 'q1', question: 'Which region?', options: null, isOther: false, isSecret: false },
                ],
            });
            return makeTurnResult({ assistantMessage: 'asked', visibleAssistantMessage: 'asked' });
        };

        await runConversation(
            { firstMessage: 'start', maxTurns: 1 },
            makeDeps({ sendTurn, log, askBus: bus }),
        );

        const askBatchEntries = log.filter((e) => e.type === 'ask_batch');
        expect(askBatchEntries).toHaveLength(1);
        expect(askBatchEntries[0]).toMatchObject({
            type: 'ask_batch',
            turn_number: 1,
            batch_id: 'bp-1',
            source: 'claude',
            lifecycle: 'post-hoc',
            source_tool: 'AskUserQuestion',
            question_count: 1,
        });

        // Ordering: ask_batch appears before the corresponding agent_result.
        const askBatchIdx = log.findIndex((e) => e.type === 'ask_batch');
        const agentResultIdx = log.findIndex((e) => e.type === 'agent_result');
        expect(askBatchIdx).toBeGreaterThanOrEqual(0);
        expect(agentResultIdx).toBeGreaterThan(askBatchIdx);
    });

    it('does not emit ask_batch entries when the bus has no batches for that turn', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const log: LogEntry[] = [];

        const sendTurn = async (): Promise<AgentTurnResult> => makeTurnResult();

        await runConversation(
            { firstMessage: 'start', maxTurns: 1 },
            makeDeps({ sendTurn, log, askBus: bus }),
        );

        expect(log.filter((e) => e.type === 'ask_batch')).toEqual([]);
    });
});
