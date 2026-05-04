import { describe, it, expect } from 'vitest';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import { AgentCrashError } from '../src/sdk/agent-crash.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';
import type { Message } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';

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

describe("runConversation: agent_crashed completionReason", () => {
    it('returns completionReason: agent_crashed with crashDiagnostic when sendTurn throws AgentCrashError under transport=app-server', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        let calls = 0;
        const sendTurn = async () => {
            calls++;
            throw new AgentCrashError('app-server exited', {
                pid: 1234,
                signal: 'SIGKILL',
                exitCode: 137,
            });
        };

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 3,
            },
            makeDeps({
                transport: 'app-server',
                agentName: 'codex',
                askBus,
                sendTurn,
            }),
        );

        expect(result.completionReason).toBe('agent_crashed');
        expect(calls).toBe(1);
        expect(result.crashDiagnostic).toBeDefined();
        expect(result.crashDiagnostic?.pid).toBe(1234);
        expect(result.crashDiagnostic?.signal).toBe('SIGKILL');
        expect(result.crashDiagnostic?.exitCode).toBe(137);
        expect(result.crashDiagnostic?.lastTurnNumber).toBe(0);
    });

    it('does NOT retry under transport=app-server when sendTurn throws a generic error', async () => {
        let calls = 0;
        const sendTurn = async () => {
            calls++;
            throw new Error('some transient failure');
        };

        const result = await runConversation(
            { firstMessage: 'Start', maxTurns: 3 },
            makeDeps({
                transport: 'app-server',
                agentName: 'codex',
                sendTurn,
            }),
        );

        expect(calls).toBe(1);
        expect(result.completionReason).toBe('error');
    });

    it('retries under transport=exec exactly as before (MAX_TURN_RETRIES=2 → 3 attempts)', async () => {
        let calls = 0;
        const sendTurn = async () => {
            calls++;
            throw new Error('transient');
        };

        const result = await runConversation(
            { firstMessage: 'Start', maxTurns: 3 },
            makeDeps({
                transport: 'exec',
                agentName: 'codex',
                sendTurn,
            }),
        );

        expect(calls).toBe(3); // initial + 2 retries
        expect(result.completionReason).toBe('error');
    }, 20_000);

    it('crashDiagnostic.partialAsks is sourced from askBus.snapshot() (bus-redacted on isSecret)', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 200 });
        let emitted = false;
        const liveSecretBatch: AskBatch = {
            batchId: 'sec-1',
            turnNumber: 0,
            source: 'codex-app-server',
            lifecycle: 'live',
            sourceTool: 'request_user_input',
            questions: [
                { id: 's1', question: 'API key?', options: null, isOther: false, isSecret: true },
            ],
        };
        // A subscriber responds with a real secret value so the snapshot can
        // demonstrate bus-level redaction.
        askBus.onAsk((_batch, respond) => {
            respond({
                answers: [{ questionId: 's1', values: ['sk-very-secret'], source: 'reaction' }],
            });
        });

        const sendTurn = async () => {
            if (!emitted) {
                emitted = true;
                const handle = askBus.emit(liveSecretBatch);
                await handle.resolution;
            }
            throw new AgentCrashError('subprocess died', {
                pid: 7,
                signal: null,
                exitCode: 1,
            });
        };

        const result = await runConversation(
            { firstMessage: 'Start', maxTurns: 2 },
            makeDeps({
                transport: 'app-server',
                agentName: 'codex',
                askBus,
                sendTurn,
            }),
        );

        expect(result.completionReason).toBe('agent_crashed');
        expect(result.crashDiagnostic?.partialAsks).toHaveLength(1);
        const partialAsk = result.crashDiagnostic!.partialAsks[0];
        expect(partialAsk.batchId).toBe('sec-1');
        expect(partialAsk.resolution?.answers[0].values).toEqual(['<redacted>']);
    });

    it('crashDiagnostic.partialToolEvents contains only non-ask-user events', async () => {
        const nonAskEvent: ToolEvent = {
            action: 'read_file',
            provider: 'codex',
            providerToolName: 'read_file',
            summary: 'read a file',
            confidence: 'high',
            rawSnippet: '',
        };
        const askEvent: ToolEvent = {
            action: 'ask_user',
            provider: 'codex',
            providerToolName: 'request_user_input',
            summary: 'ask user',
            confidence: 'high',
            rawSnippet: '',
        };

        const sendTurn = async () => {
            const err = new AgentCrashError('died', { pid: 1, signal: null, exitCode: 1 });
            err.partialToolEvents = [nonAskEvent, askEvent];
            throw err;
        };

        const result = await runConversation(
            { firstMessage: 'Start', maxTurns: 2 },
            makeDeps({
                transport: 'app-server',
                agentName: 'codex',
                sendTurn,
            }),
        );

        expect(result.completionReason).toBe('agent_crashed');
        expect(result.crashDiagnostic?.partialToolEvents).toEqual([nonAskEvent]);
    });

    it('lastTurnNumber reflects the turn count reached before the crash', async () => {
        let calls = 0;
        const sendTurn = async () => {
            calls++;
            if (calls === 1) return 'turn 1 output';
            throw new AgentCrashError('died', { pid: 1, signal: null, exitCode: 1 });
        };

        const result = await runConversation(
            { firstMessage: 'Start', maxTurns: 5, reactions: [{ when: /turn 1/, reply: 'continue' }] },
            makeDeps({
                transport: 'app-server',
                agentName: 'codex',
                sendTurn,
            }),
        );

        expect(result.completionReason).toBe('agent_crashed');
        expect(result.crashDiagnostic?.lastTurnNumber).toBe(1);
    });
});
