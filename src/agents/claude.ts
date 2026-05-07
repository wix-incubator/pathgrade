/**
 * Claude agent driver — Claude Agent SDK edition.
 *
 * Replaces the previous CLI-scraping driver with one built on
 * `@anthropic-ai/claude-agent-sdk`. The driver class is just orchestration
 * over five deep modules:
 *
 *   - `sandboxedClaudeSpawn`      — `Options.spawnClaudeCodeProcess` adapter
 *                                   that filters env and (optionally) wraps
 *                                   argv with macOS sandbox-exec.
 *   - `loadMcpServersForSdk`      — reads pathgrade's MCP config JSON into
 *                                   the SDK's `Options.mcpServers` shape.
 *   - `buildClaudeSdkOptions`     — pure builder for the per-turn `Options`.
 *   - `createAskUserBridge`       — live `canUseTool` that auto-allows
 *                                   non-`AskUserQuestion` tools and resolves
 *                                   `AskUserQuestion` through the ask-bus,
 *                                   returning the SDK's documented `answers`
 *                                   map shape on `updatedInput`. Per-turn
 *                                   answer store feeds the projector.
 *   - `projectSdkMessages`        — pure typed-message → `AgentTurnResult`
 *                                   projector. Replaces the legacy NDJSON
 *                                   parser wholesale.
 */
import {
    query as sdkQuery,
    type Options as SdkOptions,
    type Query,
    type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
    AgentCommandRunner,
    AgentSession,
    AgentSessionOptions,
    AgentTurnResult,
    BaseAgent,
    EnvironmentHandle,
    getRuntimeEnv,
    getWorkspacePath,
} from '../types.js';
import { createSandboxedClaudeSpawn } from '../providers/sandboxed-claude-spawn.js';
import { loadMcpServersForSdk } from '../providers/mcp-config.js';
import {
    buildClaudeSdkOptions,
    resolveClaudeCodeExecutable,
} from './claude/sdk-options.js';
import { projectSdkMessages } from './claude/sdk-message-projector.js';
import { createAskUserBridge } from './claude/ask-user-bridge.js';
import { createAskUserAnswerStore } from './claude/ask-user-answer-store.js';
import { requireAskBusForLiveBatches } from '../sdk/ask-bus/bus.js';

/** Shape of the SDK `query()` callable, narrowed for orchestration use. */
export type ClaudeSdkQueryFn = (args: {
    prompt: string | unknown;
    options?: SdkOptions;
}) => Query;

export interface ClaudeAgentDeps {
    /** Override the SDK `query()` for tests. Defaults to the real SDK. */
    query?: ClaudeSdkQueryFn;
    /** Override the host platform check for tests. Defaults to `process.platform`. */
    platform?: NodeJS.Platform;
    /** Override the host env for the spawn module's filter. Defaults to `process.env`. */
    hostEnv?: NodeJS.ProcessEnv;
    /** Override `process.env.PATHGRADE_CLAUDE_CODE_EXECUTABLE` for tests. */
    envExecutable?: string;
    /** Optional macOS sandbox-exec profile. None today; preserves the seam. */
    sandboxProfile?: string;
}

export interface ClaudeAgentOptions {
    /**
     * Path to a Claude binary that overrides the SDK's bundled per-platform
     * default. Run-level (set on the agent constructor); per-fixture override
     * is intentionally out of scope.
     */
    claudeCodeExecutable?: string;
}

export class ClaudeAgent extends BaseAgent {
    constructor(
        private readonly deps: ClaudeAgentDeps = {},
        private readonly opts: ClaudeAgentOptions = {},
    ) {
        super();
    }

    async createSession(
        runtime: EnvironmentHandle,
        _runCommand: AgentCommandRunner,
        sessionOptions?: AgentSessionOptions,
    ): Promise<AgentSession> {
        // Live ask-user batches require a real subscriber. Fail fast at session
        // construction rather than silently sending an empty answer back to
        // Claude on the wire when the bus is missing.
        const askBus = requireAskBusForLiveBatches(sessionOptions, 'ClaudeSdkAgent');
        const workspacePath = getWorkspacePath(runtime);
        const queryFn: ClaudeSdkQueryFn = this.deps.query ?? (sdkQuery as unknown as ClaudeSdkQueryFn);
        const platform = this.deps.platform ?? process.platform;
        const hostEnv = this.deps.hostEnv ?? process.env;
        const envExecutable = this.deps.envExecutable ?? process.env.PATHGRADE_CLAUDE_CODE_EXECUTABLE;

        const sandboxedSpawn = createSandboxedClaudeSpawn({
            platform,
            hostEnv,
            sandboxProfile: this.deps.sandboxProfile,
        });
        const claudeCodeExecutable = resolveClaudeCodeExecutable({
            agentOptionsExecutable: this.opts.claudeCodeExecutable,
            envExecutable,
        });
        const mcpServers = await loadMcpServersForSdk(workspacePath);

        let priorSessionId: string | undefined;
        let turnNumber = 0;
        // The live ask-user bridge resolves AskUserQuestion through the bus
        // and writes the resulting answers + source into the per-turn answer
        // store; the projector merges those onto the AskUserQuestion
        // ToolEvent envelope. The store is rebuilt per turn so a question on
        // turn 2 cannot read a stale answer from turn 1 even on toolUseID
        // collisions.
        let answerStore = createAskUserAnswerStore();
        const bridge = createAskUserBridge({
            askBus,
            getTurnNumber: () => turnNumber,
            answerStore: { record: (id, e) => answerStore.record(id, e), get: (id) => answerStore.get(id) },
        });

        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            turnNumber += 1;
            answerStore = createAskUserAnswerStore();
            // Clear any ask-bus rejection captured on a prior turn so a
            // stale error never causes a spurious result on this turn.
            bridge.clearLastError();
            const sdkOptions = buildClaudeSdkOptions({
                workspacePath,
                spawnClaudeCodeProcess: sandboxedSpawn,
                canUseTool: bridge,
                runtimeEnv: getRuntimeEnv(runtime),
                model: sessionOptions?.model,
                claudeCodeExecutable,
                resume: priorSessionId,
                mcpServers,
            });

            const messages: SDKMessage[] = [];
            const stream = queryFn({ prompt: message, options: sdkOptions });
            for await (const msg of stream as unknown as AsyncIterable<SDKMessage>) {
                messages.push(msg);
            }
            // The legacy NDJSON parser only synthesized the slash-command
            // `use_skill` event from the *opening* user message. The Claude
            // SDK emits a fresh `init` system message (carrying `skills`) on
            // every `query()` call — each turn spawns a fresh subprocess —
            // so passing the current turn's message into the projector on
            // turn 2+ would re-fire synthesis for the same skill activation.
            // Gate by turn number to preserve the legacy semantic: synthesize
            // on turn 1 only, never thereafter.
            const projectorFirstMessage = turnNumber === 1 ? message : undefined;
            const projected = projectSdkMessages({
                messages,
                turnNumber,
                firstMessage: projectorFirstMessage,
                answerStore,
            });
            // Capture the SDK-reported session id BEFORE checking for a bus
            // rejection so the next turn's `Options.resume` points at this
            // turn's session even when the turn ended in an ask-bus error.
            if (projected.sessionId) priorSessionId = projected.sessionId;

            // An ask-bus rejection (timeout, missing subscriber, handler
            // throw) produced an SDK deny mid-turn AND captured the underlying
            // error on the bridge. Returning an error `AgentTurnResult` rather
            // than throwing lets the conversation runner project the partial
            // turn through `pushModelAgentMessage` (`ask_batch`,
            // `model_agent_result`, turn timings/details) before propagating
            // the failure — preserving observability into what the agent
            // attempted before being killed.
            const bridgeError = bridge.lastError();
            if (bridgeError) {
                const errorMessage = bridgeError instanceof Error
                    ? bridgeError.message
                    : String(bridgeError);
                return {
                    ...projected.result,
                    exitCode: 1,
                    errorSubtype: 'bus_rejection',
                    rawOutput: errorMessage,
                };
            }
            return projected.result;
        };

        return {
            start: ({ message }) => runTurn(message),
            reply: ({ message }) => runTurn(message),
        };
    }

    // Note: ClaudeAgent does not override `run()`. The driver's session
    // construction requires an `askBus` for live `AskUserQuestion` batches,
    // which `run()` cannot supply. Rather than route through `createSession`
    // and surface "askBus required" — a misleading error suggesting the
    // caller could add an argument — the class inherits `BaseAgent.run()`'s
    // diagnostic "Agent must implement createSession() or run()" so the
    // failure mode points the caller at the right API surface.
}
