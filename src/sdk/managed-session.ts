import type {
    AgentCommandRunner,
    AgentSession,
    AgentSessionOptions,
    AgentTurnResult,
    LogEntry,
} from '../types.js';
import { createAgentSession } from '../types.js';
import { createAgentEnvironment } from '../agents/registry.js';
import { withAbortTimeout } from '../utils/timeout.js';
import type { Workspace } from '../providers/workspace.js';
import type { AgentName, AgentTransport, Message } from './types.js';
import type { LLMPort } from '../utils/llm-types.js';
import { buildModelAgentResultLogEntry } from './agent-result-log.js';
import { planRuntimePolicies } from './runtime-policy.js';
import { getVisibleAssistantMessage } from './visible-turn.js';
import { createAskBus } from './ask-bus/bus.js';
import type { AskBus } from './ask-bus/types.js';

export interface ManagedSessionDeps {
    ws: Workspace;
    agentName: AgentName;
    timeoutSec: number;
    messages: Message[];
    log: LogEntry[];
    model?: string;
    conversationWindow?: import('./types.js').ConversationWindowConfig | false;
    llm?: LLMPort;
    /**
     * Per-conversation ceiling (ms) for live `ask_user` resolution. Threaded
     * into `createAskBus` at session construction.
     */
    askUserTimeoutMs?: number;
    /**
     * Pre-constructed bus. When provided, the managed session uses it and does
     * not create its own. Test/advanced paths can plug in a custom bus; normal
     * callers should omit this and rely on default construction.
     */
    askBus?: AskBus;
    /**
     * Resolved Codex transport. When omitted, runtime-policy planning and
     * driver capabilities fall back to the default (`exec` semantics).
     */
    transport?: AgentTransport;
}

export interface ManagedSession {
    /** Full lifecycle: log start/result, push messages, check exit code. */
    send(message: string): Promise<string>;
    /** Raw turn execution — returns AgentTurnResult. Caller handles logging. */
    executeTurn(message: string): Promise<AgentTurnResult>;
    /** Remaining ms before the session-level deadline. */
    remainingMs(): number;
    /** Per-conversation ask-user bus. */
    readonly askBus: AskBus;
    /**
     * Tear down the underlying agent session (close transport, kill subprocess,
     * release stdio). Optional so that existing mocks and legacy drivers
     * without teardown work unchanged. Idempotent; safe to call before any
     * turn has run; a no-op for agents whose sessions do not implement
     * {@link AgentSession.dispose}.
     */
    dispose?(): Promise<void>;
}

export function createManagedSession(deps: ManagedSessionDeps): ManagedSession {
    const { ws, agentName, timeoutSec, messages, log, model, conversationWindow, llm } = deps;
    const agentTimeoutMs = timeoutSec * 1000;
    const deadlineMs = Date.now() + agentTimeoutMs;
    const label = `Agent (limit: ${timeoutSec}s)`;

    const transport = deps.transport;
    const agent = createAgentEnvironment(agentName, transport);
    const runtimePolicies = planRuntimePolicies(agentName, transport);
    const askBus: AskBus = deps.askBus
        ?? createAskBus({ askUserTimeoutMs: deps.askUserTimeoutMs ?? 30_000 });
    const sessionOptions: AgentSessionOptions = {
        ...(ws.mcpConfigPath ? { mcpConfigPath: ws.mcpConfigPath } : {}),
        ...(model ? { model } : {}),
        ...(conversationWindow !== undefined ? { conversationWindow } : {}),
        ...(runtimePolicies.length > 0 ? { runtimePolicies } : {}),
        ...(llm ? { llm } : {}),
        askBus,
        ...(transport !== undefined ? { transport } : {}),
    };

    let session: AgentSession | null = null;
    let setupDone = false;
    let currentSignal: AbortSignal | undefined;

    const runCommand: AgentCommandRunner = async (cmd) => {
        const result = await ws.exec(cmd, { signal: currentSignal });
        log.push({
            type: 'command',
            timestamp: new Date().toISOString(),
            command: cmd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
        });
        return result;
    };

    const executeTurn = async (message: string): Promise<AgentTurnResult> => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) throw new Error(`${label} timed out`);

        return withAbortTimeout(async (signal) => {
            currentSignal = signal;
            if (!session) {
                // Run auth setup commands before first agent turn
                if (!setupDone) {
                    for (const cmd of ws.setupCommands) {
                        await ws.exec(cmd);
                    }
                    setupDone = true;
                }
                session = await createAgentSession(agent, ws.path, runCommand, sessionOptions);
                return session.start({ message });
            }
            return session.reply({ message });
        }, remaining, label);
    };

    return {
        async send(message: string): Promise<string> {
            const isFirst = messages.length === 0;
            log.push({
                type: isFirst ? 'agent_start' : 'user_reply',
                timestamp: new Date().toISOString(),
                instruction: message,
            });
            messages.push({ role: 'user', content: message });

            const turnResult = await executeTurn(message);
            const response = getVisibleAssistantMessage(turnResult);

            log.push(buildModelAgentResultLogEntry({
                timestamp: new Date().toISOString(),
                turnResult,
                assistantMessage: response,
            }));
            for (const toolEvent of turnResult.toolEvents) {
                log.push({ type: 'tool_event', timestamp: new Date().toISOString(), tool_event: toolEvent });
            }

            messages.push({ role: 'agent', content: response });

            if (turnResult.exitCode !== 0) {
                if (turnResult.timedOut) throw new Error(`${label} timed out (agent killed)`);
                throw new Error(`Agent exited with code ${turnResult.exitCode}`);
            }

            return response;
        },

        executeTurn,

        remainingMs(): number {
            return Math.max(0, deadlineMs - Date.now());
        },

        async dispose(): Promise<void> {
            if (!session) return;
            await session.dispose?.();
        },

        askBus,
    };
}
