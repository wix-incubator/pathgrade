/**
 * Claude agent driver — Claude Agent SDK edition.
 *
 * Replaces the previous CLI-scraping driver with one built on
 * `@anthropic-ai/claude-agent-sdk`. The driver class is just orchestration
 * over four deep modules (PRD §Module decomposition):
 *
 *   - `sandboxedClaudeSpawn`      — `Options.spawnClaudeCodeProcess` adapter
 *                                   that filters env and (optionally) wraps
 *                                   argv with macOS sandbox-exec.
 *   - `loadMcpServersForSdk`      — reads pathgrade's MCP config JSON into
 *                                   the SDK's `Options.mcpServers` shape.
 *   - `buildClaudeSdkOptions`     — pure builder for the per-turn `Options`.
 *   - `placeholderCanUseTool`     — interim `canUseTool` that auto-allows
 *                                   non-`AskUserQuestion` tools and denies
 *                                   `AskUserQuestion` with a self-explanatory
 *                                   message until issue #004 lands the live
 *                                   ask-user bridge.
 *
 * The SDK message projector (assistant text, tool events, typed errors,
 * cache tokens, `cost_usd`) is a separate module that lands in issue #002;
 * for now this driver consumes only what the orchestration shell needs:
 * `init.session_id` for `resume`, and the `result` exit/usage for the
 * minimum-viable `AgentTurnResult`.
 *
 * The legacy NDJSON parser `extractClaudeStreamJsonEvents` is kept as an
 * exported helper because `tests/tool-events.test.ts` still consumes it; it
 * is no longer called from inside this file. Issue #002 will replace those
 * tests with SDK-message-projector tests and the function can be removed.
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
import { ToolEvent, TOOL_NAME_MAP, buildSummary, enrichSkillEvents } from '../tool-events.js';
import { createSandboxedClaudeSpawn } from '../providers/sandboxed-claude-spawn.js';
import { loadMcpServersForSdk } from '../providers/mcp-config.js';
import {
    buildClaudeSdkOptions,
    resolveClaudeCodeExecutable,
} from './claude/sdk-options.js';
import { createPlaceholderCanUseTool } from './claude/can-use-tool-placeholder.js';

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
        const canUseTool = createPlaceholderCanUseTool();
        const claudeCodeExecutable = resolveClaudeCodeExecutable({
            agentOptionsExecutable: this.opts.claudeCodeExecutable,
            envExecutable,
        });
        const mcpServers = await loadMcpServersForSdk(workspacePath);

        let priorSessionId: string | undefined;

        const runTurn = async (message: string): Promise<AgentTurnResult> => {
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
            const turn = projectTurn(messages);
            if (turn.sessionId) priorSessionId = turn.sessionId;
            return turn.result;
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

interface ProjectedTurn {
    result: AgentTurnResult;
    sessionId?: string;
}

/**
 * Minimum-viable projection from the typed SDK message stream into an
 * `AgentTurnResult`. Picks up enough state to satisfy the orchestration
 * shell's contract: assistant text, exit code, session id, basic token
 * totals. The full projector — tool events, cache-token breakdown, typed
 * errors, `cost_usd`, init-skill enrichment — lands in issue #002.
 */
function projectTurn(messages: SDKMessage[]): ProjectedTurn {
    let assistantText = '';
    let sessionId: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let exitCode = 0;
    let isError = false;
    let resultText = '';

    for (const msg of messages) {
        switch (msg.type) {
            case 'system': {
                if ((msg as { subtype?: string }).subtype === 'init') {
                    const init = msg as { session_id?: string };
                    if (init.session_id) sessionId = init.session_id;
                }
                break;
            }
            case 'assistant': {
                const message = (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
                for (const block of message?.content ?? []) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        assistantText += block.text;
                    }
                }
                break;
            }
            case 'result': {
                const result = msg as {
                    subtype?: string;
                    is_error?: boolean;
                    result?: string;
                    session_id?: string;
                    usage?: {
                        input_tokens?: number;
                        output_tokens?: number;
                        cache_creation_input_tokens?: number;
                        cache_read_input_tokens?: number;
                    };
                };
                if (result.session_id) sessionId = result.session_id;
                if (result.usage) {
                    inputTokens =
                        (result.usage.input_tokens ?? 0)
                        + (result.usage.cache_creation_input_tokens ?? 0)
                        + (result.usage.cache_read_input_tokens ?? 0);
                    outputTokens = result.usage.output_tokens;
                }
                if (result.is_error || result.subtype !== 'success') {
                    isError = true;
                    exitCode = 1;
                }
                if (typeof result.result === 'string') resultText = result.result;
                break;
            }
            default:
                break;
        }
    }

    const visibleAssistantMessage = assistantText.trim() || resultText.trim();

    const result: AgentTurnResult = {
        rawOutput: resultText || assistantText,
        assistantMessage: isError ? '' : (assistantText.trim() || resultText.trim()),
        visibleAssistantMessage: isError ? '' : visibleAssistantMessage,
        visibleAssistantMessageSource: 'assistant_message',
        exitCode,
        traceOutput: '',
        timedOut: undefined,
        blockedPrompts: [],
        toolEvents: [],
        runtimePoliciesApplied: [],
        inputTokens,
        outputTokens,
    };
    return { result, sessionId };
}

/**
 * Legacy NDJSON tool-event extractor. Kept exported only because
 * `tests/tool-events.test.ts` still consumes it; the SDK driver itself does
 * not call it. Issue #002 ships the typed-message projector that supersedes
 * this function and removes the export.
 */
export function extractClaudeStreamJsonEvents(
    traceOutput: string,
    turnNumber?: number,
    firstMessage?: string,
): ToolEvent[] {
    const events: ToolEvent[] = [];
    let initSkills: string[] | undefined;

    for (const line of traceOutput.split('\n')) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (parsed.type === 'system' && parsed.subtype === 'init' && Array.isArray(parsed.skills)) {
            initSkills = parsed.skills as string[];
        }

        if (parsed.type !== 'assistant') continue;

        const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
        const content = message?.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
            if (block.type !== 'tool_use') continue;

            const providerToolName = String(block.name || 'unknown');
            const args = (block.input as Record<string, unknown>) || undefined;
            const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
            const summary = buildSummary(action, providerToolName, args);
            const rawSnippet = JSON.stringify(block).slice(0, 200);

            events.push({
                action,
                provider: 'claude',
                providerToolName,
                turnNumber,
                arguments: args,
                summary,
                confidence: 'high',
                rawSnippet,
            });
        }
    }

    const enriched = enrichSkillEvents(events);

    if (firstMessage && initSkills) {
        const match = firstMessage.match(/^\/([^\s]+)/);
        if (match && initSkills.includes(match[1])) {
            const skillName = match[1];
            enriched.unshift({
                action: 'use_skill',
                provider: 'claude',
                providerToolName: 'Skill',
                arguments: { skill: skillName },
                skillName,
                summary: `use_skill "${skillName}"`,
                confidence: 'high',
                rawSnippet: '(detected from slash command in prompt)',
            });
        }
    }

    return enriched;
}
