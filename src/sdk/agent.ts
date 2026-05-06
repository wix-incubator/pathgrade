import {
    AgentTurnResult,
    CommandResult,
    LogEntry,
} from '../types.js';
import { prepareWorkspace, Workspace } from '../providers/workspace.js';
import type {
    AgentName,
    AgentTransport,
    ChatSession,
    ConversationResult,
    ConversationWindowConfig,
    ConverseOptions,
    Message,
    Agent,
    AgentOptions,
} from './types.js';
import { resolveAgentName, resolveCodexTransport } from './agent-resolution.js';
import { lifecycle } from '../plugin/lifecycle.js';
import { ChatSessionImpl } from './chat.js';
import { runConversation } from './converse.js';
import { createPersona } from './persona.js';
import { evaluate } from './evaluate.js';
import { createManagedSession, type ManagedSession } from './managed-session.js';
import { createAgentLLM } from '../utils/llm.js';
import type { LLMPort } from '../utils/llm-types.js';
import { buildRunSnapshot } from './snapshots.js';
import { buildModelAgentResultLogEntry } from './agent-result-log.js';
import { getVisibleAssistantMessage } from './visible-turn.js';
import { createVerboseEmitter, type VerboseEmitter, type VerboseSink } from '../reporters/verbose-emitter.js';
import fs from 'fs-extra';
import * as path from 'path';

/**
 * Test-only injection point: override the sink used by the next emitter
 * built inside `createAgent`. Pass `null` to restore the default (stderr).
 * Intended for unit tests only — do not use in production code paths.
 */
let verboseSinkOverride: VerboseSink | null = null;
export function __setVerboseSinkForTesting(sink: VerboseSink | null): void {
    verboseSinkOverride = sink;
}

type InteractionMode = 'prompt' | 'startChat' | 'runConversation';

class AgentImpl implements Agent {
    private ws: Workspace;
    private agentName: AgentName;
    readonly llm: LLMPort;
    private timeoutSetting: number | 'auto';
    private modelOpt: string | undefined;
    private conversationWindowOpt: ConversationWindowConfig | false | undefined;
    private interactionMode: InteractionMode | null = null;
    private _messages: Message[] = [];
    private _log: LogEntry[] = [];
    private disposed = false;
    private debugOpt: boolean | string | undefined;
    private debugName: string;
    private debugBaseDir: string;
    private lastConversationResult: ConversationResult | null = null;
    readonly verbose: VerboseEmitter;
    private transport?: AgentTransport;

    constructor(ws: Workspace, agentName: AgentName, llm: LLMPort, timeoutSetting: number | 'auto', conversationWindow: ConversationWindowConfig | false | undefined, modelOpt: string | undefined, debugOpt: boolean | string | undefined, debugName: string, debugBaseDir: string, verbose: VerboseEmitter, transport?: AgentTransport) {
        this.ws = ws;
        this.agentName = agentName;
        this.llm = llm;
        this.timeoutSetting = timeoutSetting;
        this.modelOpt = modelOpt;
        this.conversationWindowOpt = conversationWindow;
        this.debugOpt = debugOpt;
        this.debugName = debugName;
        this.debugBaseDir = debugBaseDir;
        this.verbose = verbose;
        this.transport = transport;
    }

    get messages(): Message[] {
        return this._messages;
    }

    get log(): LogEntry[] {
        return this._log;
    }

    get workspace(): string {
        return this.ws.path;
    }

    private guardInteraction(mode: InteractionMode): void {
        if (this.interactionMode && this.interactionMode !== mode) {
            throw new Error(
                `Cannot use ${mode}() after ${this.interactionMode}() — an agent supports only one interaction method`,
            );
        }
        this.interactionMode = mode;
    }

    private createSession(timeoutSec: number, askUserTimeoutMs?: number): ManagedSession {
        return createManagedSession({
            ws: this.ws,
            agentName: this.agentName,
            timeoutSec,
            messages: this._messages,
            log: this._log,
            model: this.modelOpt,
            conversationWindow: this.conversationWindowOpt,
            llm: this.llm,
            ...(askUserTimeoutMs !== undefined ? { askUserTimeoutMs } : {}),
            ...(this.transport !== undefined ? { transport: this.transport } : {}),
        });
    }

    private resolveTimeoutSec(mode: InteractionMode, maxTurns?: number): number {
        if (this.timeoutSetting !== 'auto') {
            return this.timeoutSetting;
        }

        if (mode !== 'runConversation') {
            throw new Error("timeout: 'auto' is only supported for runConversation()");
        }

        const turns = maxTurns ?? 30;
        return Math.ceil((turns * 80_000 + 200_000) / 1000);
    }

    private async executeLoggedTurnResult(
        session: ManagedSession,
        message: string,
        turnNumber: number,
        kind: 'agent_start' | 'user_reply',
    ): Promise<AgentTurnResult> {
        const timestamp = () => new Date().toISOString();
        this._messages.push({ role: 'user', content: message });
        this._log.push({
            type: kind,
            timestamp: timestamp(),
            instruction: message,
            ...(kind === 'user_reply' ? { turn_number: turnNumber } : {}),
        });
        this.verbose.turnStart({ turn: turnNumber, kind, message });

        const turnStart = Date.now();
        const turnResult = await session.executeTurn(message);
        const response = getVisibleAssistantMessage(turnResult);
        const durationMs = Date.now() - turnStart;

        this._log.push(buildModelAgentResultLogEntry({
            timestamp: timestamp(),
            turnNumber,
            durationMs,
            turnResult,
            assistantMessage: response,
        }));
        for (const toolEvent of turnResult.toolEvents) {
            this._log.push({
                type: 'tool_event',
                timestamp: timestamp(),
                tool_event: toolEvent,
            });
            this.verbose.toolEvent({ action: toolEvent.action, summary: toolEvent.summary });
        }

        this._messages.push({ role: 'agent', content: response });
        this.verbose.turnEnd({
            turn: turnNumber,
            durationMs,
            outputLines: response.split('\n').length,
            messagePreview: response,
        });

        if (turnResult.exitCode !== 0) {
            const timeoutSec = this.resolveTimeoutSec(this.interactionMode ?? 'prompt');
            if (turnResult.timedOut) {
                throw new Error(`Agent (limit: ${timeoutSec}s) timed out (agent killed)`);
            }
            throw new Error(`Agent exited with code ${turnResult.exitCode}`);
        }

        return turnResult;
    }

    private async executeLoggedTurn(
        session: ManagedSession,
        message: string,
        turnNumber: number,
        kind: 'agent_start' | 'user_reply',
    ): Promise<string> {
        const turnResult = await this.executeLoggedTurnResult(session, message, turnNumber, kind);
        return getVisibleAssistantMessage(turnResult);
    }

    async prompt(message: string): Promise<string> {
        this.guardInteraction('prompt');
        if (this._messages.length > 0) {
            throw new Error('prompt() can only be called once per agent');
        }
        const ms = this.createSession(this.resolveTimeoutSec('prompt'));
        try {
            return await this.executeLoggedTurn(ms, message, 1, 'agent_start');
        } finally {
            await ms.dispose?.();
        }
    }

    async startChat(firstMessage: string): Promise<ChatSession> {
        this.guardInteraction('startChat');
        if (this._messages.length > 0) {
            throw new Error('startChat() can only be called once per agent');
        }

        const timeoutSec = this.resolveTimeoutSec('startChat');
        const ms = this.createSession(timeoutSec);
        const turnResult = await this.executeLoggedTurnResult(ms, firstMessage, 1, 'agent_start');

        return new ChatSessionImpl(turnResult, {
            messages: this._messages,
            log: this._log,
            exec: (cmd) => this.exec(cmd),
            sendTurn: (message) => ms.executeTurn(message),
            verbose: this.verbose,
        });
    }

    async runConversation(opts: ConverseOptions): Promise<ConversationResult> {
        this.guardInteraction('runConversation');
        if (this._messages.length > 0) {
            throw new Error('runConversation() can only be called once per agent');
        }

        const timeoutSec = this.resolveTimeoutSec('runConversation', opts.maxTurns);
        const ms = this.createSession(timeoutSec, opts.askUserTimeoutMs);
        let turnNumber = 0;

        const sendTurn = async (message: string): Promise<AgentTurnResult> => {
            const turnResult = await ms.executeTurn(message);
            turnNumber++;

            // Accumulate agent turn tokens (from CLI stream-json) on the shared tracker
            if (turnResult.inputTokens || turnResult.outputTokens) {
                this.llm.addTokens?.(turnResult.inputTokens ?? 0, turnResult.outputTokens ?? 0);
            }
            // #003: accumulate agent turn cost on the same shared tracker
            // when the upstream provider reports it (Claude SDK populates
            // `costUsd` from `total_cost_usd`; Codex/Cursor leave it
            // undefined, in which case this is a no-op).
            if (turnResult.costUsd !== undefined) {
                this.llm.addCost?.(turnResult.costUsd);
            }

            for (const toolEvent of turnResult.toolEvents) {
                this._log.push({
                    type: 'tool_event',
                    timestamp: new Date().toISOString(),
                    tool_event: toolEvent,
                });
            }

            // Exit-code failures are no longer thrown here. The runConversation
            // loop projects the partial-turn through `pushModelAgentMessage`
            // first (so `model_agent_result`, `ask_batch`, turn timings/details
            // all capture the failed turn) and then throws — preserving
            // observability into what the agent attempted before the failure.
            return turnResult;
        };

        // Set up persona reply callback if persona config provided
        let personaReply: (() => Promise<string>) | undefined;
        if (opts.persona) {
            const personaWindowConfig = opts.persona.conversationWindow !== undefined
                ? opts.persona.conversationWindow
                : this.conversationWindowOpt;
            const persona = createPersona({
                ...opts.persona,
                llm: opts.persona.llm ?? this.llm,
                conversationWindow: personaWindowConfig,
            });
            personaReply = async () => {
                const fakeChatSession = {
                    turn: turnNumber,
                    done: false,
                    lastMessage: this._messages[this._messages.length - 1]?.content ?? '',
                    messages: this._messages,
                    reply: async () => {},
                    hasFile: async () => false,
                    end: () => {},
                };
                return persona.reply(fakeChatSession);
            };
        }

        // Set up step scorer runner — pass this.llm explicitly so step
        // scorer judge calls accumulate on the same tracker.
        const agent = this as Agent;
        const runStepScorers = async (scorers: import('./types.js').Scorer[]) => {
            return evaluate(agent, scorers, { llm: this.llm });
        };

        try {
            const result = await runConversation(opts, {
                sendTurn,
                hasFile: async (pattern) => {
                    const result = await this.exec(`ls -d ${pattern} 2>/dev/null`);
                    return result.stdout.trim().length > 0;
                },
                workspace: this.workspace,
                messages: this._messages,
                log: this._log,
                personaReply,
                runStepScorers,
                verbose: this.verbose,
                askBus: ms.askBus,
                agentName: this.agentName,
                agentTimeoutSec: timeoutSec,
                ...(this.transport !== undefined ? { transport: this.transport } : {}),
            });
            this.lastConversationResult = result;
            return result;
        } finally {
            await ms.dispose?.();
        }
    }

    async exec(cmd: string): Promise<CommandResult> {
        return this.ws.exec(cmd);
    }

    transcript(): string {
        const parts: string[] = [];
        for (const msg of this._messages) {
            const label = msg.role === 'user' ? 'User' : 'Agent';
            parts.push(`[${label}]\n${msg.content}`);
        }
        return parts.join('\n\n');
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        // Do NOT call lifecycle.untrackAgent here — flush() in afterEach needs
        // the agent to still be in pendingAgents so it can collect results
        // (token usage, scorers, diagnostics) into task.meta.pathgrade.

        if (this.debugOpt) {
            const dest = typeof this.debugOpt === 'string'
                ? this.debugOpt
                : path.join(this.debugBaseDir, 'pathgrade-debug', this.debugName);
            await fs.remove(dest);
            await fs.copy(this.ws.path, dest);
            if (this.interactionMode === 'runConversation' && this.lastConversationResult) {
                const snapshot = buildRunSnapshot({
                    agent: this.agentName,
                    messages: this._messages,
                    log: this._log,
                    conversationResult: this.lastConversationResult,
                    workspace: dest,
                });
                await fs.writeJSON(path.join(dest, 'run-snapshot.json'), snapshot, { spaces: 2 });
            }
        }

        await this.ws.dispose();
    }
}

/**
 * Create an isolated trial for agent evaluation.
 *
 * Workspace is set up immediately (files copied, skills staged, MCP configured).
 * The agent process is NOT started — it's spawned lazily on first instruct()/chat()/converse().
 */
function slugify(s: string): string {
    return s
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
}

function resolveTestContext(): { name: string; dir: string } {
    try {
        const worker = (globalThis as any).__vitest_worker__;
        const name = worker?.current?.name ? slugify(worker.current.name) : '';
        const dir = worker?.filepath ? path.dirname(worker.filepath) : '';
        return { name, dir };
    } catch {
        return { name: '', dir: '' };
    }
}

export async function createAgent(opts: AgentOptions): Promise<Agent> {
    const agentName: AgentName = resolveAgentName(opts, process.env);
    const transport: AgentTransport | undefined = agentName === 'codex'
        ? resolveCodexTransport(opts, process.env)
        : undefined;
    const timeoutSetting = opts.timeout ?? 300;

    // Capture test context now, while vitest state is available
    const testCtx = opts.debug ? resolveTestContext() : { name: '', dir: '' };

    const { timeout: _, mcpMock, agent: __, debug: ___, model: ____, transport: _____, ...rest } = opts;
    const workspace = await prepareWorkspace({
        ...rest,
        agent: agentName,
        mcp: mcpMock ? { mock: mcpMock } : undefined,
    });

    // Create agent LLM once, using the fully-resolved sandbox env (includes
    // keychain OAuth tokens, API keys, safe host vars).
    const llm = createAgentLLM(agentName, workspace.env);

    // Fall back to sandbox dir name if no test name resolved
    const debugName = testCtx.name || path.basename(path.dirname(workspace.path));
    // Default debug dir is next to the eval file, fallback to cwd
    const debugBaseDir = testCtx.dir || process.cwd();

    const verbose = createVerboseEmitter({
        enabled: process.env.PATHGRADE_VERBOSE === '1',
        sink: verboseSinkOverride ?? undefined,
        testName: testCtx.name || undefined,
    });

    const agent = new AgentImpl(workspace, agentName, llm, timeoutSetting, opts.conversationWindow, opts.model, opts.debug, debugName, debugBaseDir, verbose, transport);
    lifecycle.trackAgent(agent);
    return agent;
}
