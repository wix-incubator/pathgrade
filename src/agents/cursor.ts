import fs from 'fs-extra';
import path from 'path';
import type { TokenUsage } from '../sdk/types.js';
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle, getWorkspacePath } from '../types.js';
import { ToolEvent, TOOL_NAME_MAP, buildSummary, enrichSkillEvents } from '../tool-events.js';
import { getVisibleAssistantMessage } from '../sdk/visible-turn.js';
import { prependRuntimePolicies } from '../sdk/runtime-policy.js';

/**
 * Cursor tool_call discriminants observed in the discovery spike. Probed in
 * order — first present key wins. Explicit probing (vs. `Object.keys(…)[0]`)
 * means a future metadata wrapper key like `id` or `ts` cannot silently
 * misclassify.
 */
const CURSOR_TOOL_DISCRIMINANTS = [
    'readToolCall',
    'editToolCall',
    'globToolCall',
    'grepToolCall',
    'shellToolCall',
    'webFetchToolCall',
    'updateTodosToolCall',
] as const;

const RAW_SNIPPET_MAX_CHARS = 200;

/**
 * Pure function: scan Cursor NDJSON for `tool_call` events with
 * `subtype: "started"` and emit a normalized `ToolEvent[]`. Enriched via
 * `enrichSkillEvents` so `readToolCall` on a `SKILL.md` is reclassified as
 * `use_skill`, matching Claude/Codex.
 *
 * `completed` subtypes are ignored (noisy, redundant for event-level scoring).
 * `interaction_query` events are ignored (approval metadata, not tool calls).
 */
export function extractCursorStreamJsonEvents(
    traceOutput: string,
    turnNumber?: number,
): ToolEvent[] {
    const events: ToolEvent[] = [];

    for (const line of traceOutput.split('\n')) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (parsed.type !== 'tool_call' || parsed.subtype !== 'started') continue;

        // Later cursor-agent builds nest the tool discriminant under a
        // `tool_call` wrapper; earlier builds (see fixtures/cursor/tool-*.ndjson)
        // place it at the top level. Probe the wrapper first, then the envelope.
        const wrapper = parsed.tool_call && typeof parsed.tool_call === 'object'
            ? parsed.tool_call as Record<string, unknown>
            : parsed;

        let discriminantKey: string | undefined;
        for (const candidate of CURSOR_TOOL_DISCRIMINANTS) {
            if (wrapper[candidate] && typeof wrapper[candidate] === 'object') {
                discriminantKey = candidate;
                break;
            }
        }

        // Unknown discriminant — fall back to the first *ToolCall-suffixed key,
        // or the first non-meta object. Preserves providerToolName so it's
        // still visible for triage, action stays 'unknown'.
        if (!discriminantKey) {
            for (const key of Object.keys(wrapper)) {
                if (key === 'type' || key === 'subtype') continue;
                if (key === 'id' || key === 'ts') continue;
                const value = wrapper[key];
                if (value && typeof value === 'object') {
                    discriminantKey = key;
                    break;
                }
            }
        }

        if (!discriminantKey) continue;

        const block = wrapper[discriminantKey] as { args?: Record<string, unknown> };
        const args = block?.args;
        const action = TOOL_NAME_MAP[discriminantKey] ?? 'unknown';
        const summary = buildSummary(action, discriminantKey, args);
        const rawSnippet = JSON.stringify(block).slice(0, RAW_SNIPPET_MAX_CHARS);

        events.push({
            action,
            provider: 'cursor',
            providerToolName: discriminantKey,
            ...(turnNumber !== undefined ? { turnNumber } : {}),
            ...(args ? { arguments: args } : {}),
            summary,
            confidence: 'high',
            rawSnippet,
        });
    }

    return enrichSkillEvents(events);
}

/**
 * Shape returned by `parseCursorStreamJson`. Mirrors Claude's envelope shape
 * plus an `interactionQueryCount` for diagnostics (approval round-trips from
 * `--force` / `--approve-mcps` — discarded here, not surfaced as ToolEvents).
 */
export interface CursorEnvelopeParseResult {
    sessionId?: string;
    isError: boolean;
    resultText: string;
    tokenUsage?: TokenUsage;
    interactionQueryCount: number;
}

/**
 * Usage shape as observed in Cursor stream-json envelopes. Matches Claude's
 * field names; confirmed when slice #08 recorder captures a real invocation.
 */
interface CursorUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

interface CursorResultEnvelope {
    type: 'result';
    is_error?: boolean;
    session_id?: string;
    result?: string;
    usage?: CursorUsage;
}

const RAW_ERROR_MAX_BYTES = 2048;

/**
 * Pure function: scan Cursor's NDJSON stream-json and return the terminal
 * envelope's key fields. If no `type: "result"` event is present (e.g. the
 * CLI emitted a plain-text "Workspace Trust Required" block), the raw stdout
 * is surfaced as a truncated error payload so the diagnostic points at the
 * real cause instead of a parser crash.
 */
export function parseCursorStreamJson(stdout: string): CursorEnvelopeParseResult {
    let result: CursorResultEnvelope | undefined;
    let interactionQueryCount = 0;

    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        if (parsed.type === 'interaction_query') {
            interactionQueryCount += 1;
            continue;
        }
        if (parsed.type === 'result') {
            result = parsed as unknown as CursorResultEnvelope;
        }
    }

    if (!result) {
        return {
            isError: true,
            resultText: stdout.slice(0, RAW_ERROR_MAX_BYTES),
            interactionQueryCount,
        };
    }

    const tokenUsage: TokenUsage | undefined = result.usage
        ? {
            inputTokens:
                (result.usage.input_tokens ?? 0)
                + (result.usage.cache_creation_input_tokens ?? 0)
                + (result.usage.cache_read_input_tokens ?? 0),
            outputTokens: result.usage.output_tokens ?? 0,
        }
        : undefined;

    return {
        sessionId: result.session_id,
        isError: !!result.is_error,
        resultText: result.result ?? '',
        tokenUsage,
        interactionQueryCount,
    };
}

// `cursor-agent --help` (2026.04.17-787b533) treats `--trust` and `--force`
// as orthogonal: `--trust` unblocks workspace-trust, `--force` bypasses
// per-command approvals. Discovery spikes saw hangs when `--trust` was
// dropped, so we pass both by default.
const CURSOR_EXECUTABLE = 'cursor-agent';

export class CursorAgent extends BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        const workspacePath = getWorkspacePath(runtime);
        let sessionId: string | undefined;

        return {
            start: async ({ message }) => {
                const result = await this.runTurn(message, workspacePath, runCommand, sessionId, options);
                sessionId = result.sessionId ?? sessionId;
                return result;
            },
            reply: async ({ message }) => {
                const result = await this.runTurn(message, workspacePath, runCommand, sessionId, options);
                sessionId = result.sessionId ?? sessionId;
                return result;
            },
        };
    }

    async run(
        instruction: string,
        workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>,
    ): Promise<string> {
        const result = await this.runTurn(instruction, workspacePath, runCommand, undefined);
        return getVisibleAssistantMessage(result);
    }

    private async runTurn(
        instruction: string,
        workspacePath: string,
        runCommand: AgentCommandRunner,
        sessionId: string | undefined,
        options?: AgentSessionOptions,
    ): Promise<AgentTurnResult & { sessionId?: string }> {
        // Runtime policies are injected into the first-turn prompt only.
        // On resumed turns (sessionId set) the policy was already delivered,
        // so we skip re-prepending. The legacy Claude CLI driver had the same
        // pattern; the post-#007 Claude SDK driver no longer prepends runtime
        // policies at all (its transport is `'reliable'`), so the previous
        // "Mirrors claude.ts" reference no longer applies — Cursor and the
        // Codex transcript agent are now the only consumers of this path.
        const appliedRuntimePolicies = sessionId ? [] : [...(options?.runtimePolicies ?? [])];
        const effectiveInstruction = appliedRuntimePolicies.length > 0
            ? prependRuntimePolicies(instruction, appliedRuntimePolicies, { agent: 'cursor' })
            : instruction;

        // Tempfile-via-argv approach: write the prompt to a shell-escape-safe
        // tempfile and splice via $(cat …). The legacy Claude CLI driver used
        // the same pattern; the SDK-based Claude driver passes `prompt`
        // directly to `query()` and no longer needs this. Cursor still does
        // because it shells out to the `cursor-agent` CLI.
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-cursor-prompt.md"';
        const b64 = Buffer.from(effectiveInstruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        // Materialize .cursor/mcp.json from pathgrade's MCP config so the
        // CLI's native loader picks it up. Idempotent per turn.
        if (options?.mcpConfigPath) {
            const srcMcp = path.join(workspacePath, options.mcpConfigPath);
            if (await fs.pathExists(srcMcp)) {
                const cursorDir = path.join(workspacePath, '.cursor');
                await fs.ensureDir(cursorDir);
                await fs.copy(srcMcp, path.join(cursorDir, 'mcp.json'), { overwrite: true });
            }
        }

        const modelFlag = options?.model ? ` --model ${options.model}` : '';
        const mcpFlag = options?.mcpConfigPath ? ' --approve-mcps' : '';
        const resumeFlag = sessionId ? ` --resume ${this.sanitizeSessionId(sessionId)}` : '';
        const command = `${CURSOR_EXECUTABLE} -p --output-format stream-json --trust --force --workspace "${workspacePath}"${resumeFlag}${modelFlag}${mcpFlag} "$(cat ${promptPath})" < /dev/null`;

        const result = await runCommand(command);

        const parsed = parseCursorStreamJson(result.stdout);
        const toolEvents = extractCursorStreamJsonEvents(result.stdout);

        const rawOutput = parsed.isError && !parsed.sessionId
            // No parseable result envelope — surface the CLI's raw text so
            // diagnostics point at the real failure (workspace-trust block,
            // auth error, etc.) instead of an empty string.
            ? (result.stdout + (result.stderr ? '\n' + result.stderr : '')).trim()
            : parsed.resultText;

        return {
            rawOutput,
            assistantMessage: parsed.isError ? '' : parsed.resultText,
            visibleAssistantMessage: parsed.isError ? '' : parsed.resultText,
            visibleAssistantMessageSource: 'assistant_message',
            exitCode: result.exitCode,
            sessionId: parsed.sessionId,
            traceOutput: result.stdout,
            timedOut: result.timedOut,
            blockedPrompts: [],
            toolEvents,
            runtimePoliciesApplied: appliedRuntimePolicies,
            ...(parsed.tokenUsage
                ? { inputTokens: parsed.tokenUsage.inputTokens, outputTokens: parsed.tokenUsage.outputTokens }
                : {}),
        };
    }

    private sanitizeSessionId(id: string): string {
        return id.replace(/[^a-zA-Z0-9_-]/g, '');
    }
}
