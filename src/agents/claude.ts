/**
 * Claude agent driver — Claude Agent SDK edition.
 *
 * Replaces the previous CLI-scraping driver with one built on
 * `@anthropic-ai/claude-agent-sdk`. The driver class is just orchestration
 * over five deep modules (PRD §Module decomposition):
 *
 *   - `sandboxedClaudeSpawn`      — `Options.spawnClaudeCodeProcess` adapter
 *                                   that filters env and (optionally) wraps
 *                                   argv with macOS sandbox-exec.
 *   - `loadMcpServersForSdk`      — reads pathgrade's MCP config JSON into
 *                                   the SDK's `Options.mcpServers` shape.
 *   - `buildClaudeSdkOptions`     — pure builder for the per-turn `Options`.
 *   - `createAskUserBridge`       — live `canUseTool` (issue #004) that
 *                                   auto-allows non-`AskUserQuestion` tools
 *                                   and resolves `AskUserQuestion` through
 *                                   the ask-bus, returning the SDK's
 *                                   documented `answers` map shape on
 *                                   `updatedInput`. Per-turn answer store
 *                                   feeds the projector.
 *   - `projectSdkMessages`        — pure typed-message → `AgentTurnResult`
 *                                   projector (issue #002). Replaces the
 *                                   legacy NDJSON parser wholesale.
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
    CommandResult,
    EnvironmentHandle,
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
     * is intentionally out of scope (PRD §Out of Scope).
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
        // Claude on the wire when the bus is missing. PRD §Module decomposition.
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
        let firstMessage: string | undefined;
        // The live ask-user bridge replaces the #001 placeholder canUseTool.
        // The bridge resolves AskUserQuestion through the bus and writes the
        // resulting answers + source into the per-turn answer store; the
        // projector merges those onto the AskUserQuestion ToolEvent envelope.
        // The store is rebuilt per turn so a question on turn 2 cannot read
        // a stale answer from turn 1 even on toolUseID collisions.
        let answerStore = createAskUserAnswerStore();
        const canUseTool = createAskUserBridge({
            askBus,
            getTurnNumber: () => turnNumber,
            answerStore: { record: (id, e) => answerStore.record(id, e), get: (id) => answerStore.get(id) },
        });

        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            turnNumber += 1;
            answerStore = createAskUserAnswerStore();
            if (firstMessage === undefined) firstMessage = message;
            const sdkOptions = buildClaudeSdkOptions({
                workspacePath,
                spawnClaudeCodeProcess: sandboxedSpawn,
                canUseTool,
                authEnv: collectAuthEnv(sessionOptions),
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
            const projected = projectSdkMessages({
                messages,
                turnNumber,
                firstMessage,
                answerStore,
            });
            if (projected.sessionId) priorSessionId = projected.sessionId;
            return projected.result;
        };

        return {
            start: ({ message }) => runTurn(message),
            reply: ({ message }) => runTurn(message),
        };
    }

    async run(
        instruction: string,
        workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>,
    ): Promise<string> {
        const session = await this.createSession(workspacePath, runCommand);
        const result = await session.start({ message: instruction });
        return result.assistantMessage;
    }
}

/**
 * Auth env the driver carries into `Options.env` for the SDK subprocess.
 * Today `AgentSessionOptions` does not expose an env-pass-through field on
 * the Claude path; the resolver lives at the workspace prep layer
 * (`prepareWorkspace` calls `resolveCredentials()`), and consumers feed the
 * resolved env via the runtime handle's env. Pull from there when present.
 */
function collectAuthEnv(sessionOptions?: AgentSessionOptions): Record<string, string> {
    void sessionOptions;
    // The orchestration shell does not yet plumb resolveCredentials() output
    // through to the SDK driver — that wiring lands when `prepareWorkspace`
    // adopts the SDK driver as its eval-time runtime. Until then, callers can
    // only set auth via `Options.env` indirectly through the SAFE_HOST_VARS
    // intersection in the spawn module (which by design does NOT include
    // ANTHROPIC_API_KEY). The smoke test `tests/claude-sdk-smoke.test.ts`
    // already exercises real-SDK auth using the same env-pass-through shape.
    return {};
}

