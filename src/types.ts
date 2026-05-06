import type { DiagnosticsReport } from './reporters/diagnostics.js';
import type { RuntimePolicyDescriptor } from './sdk/runtime-policy.js';
import type { LLMPort } from './utils/llm-types.js';

type ProcessSignal = string;

export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    killed?: boolean;
}

export interface TurnCommand extends CommandResult {
    command: string;
}

export type ConversationReplySource = 'opener' | 'reaction' | 'persona_llm';

export interface ConversationTurn {
    turn_number: number;
    user_message: string;
    user_message_source: ConversationReplySource;
    raw_agent_output: string;
    assistant_message: string;
    duration_ms: number;
    commands: TurnCommand[];
    turn_status: 'completed' | 'error' | 'timeout';
    step_scorer_results?: ScorerResult[];
    tool_events?: import('./tool-events.js').ToolEvent[];
}

export type ConversationCompletionReason =
    | 'max_turns'
    | 'signal'
    | 'done_phrase'
    | 'done_when'
    | 'timeout'
    | 'no_replies'
    | 'error';


export interface ScorerResult {
    scorer_type: string;
    score: number;      // 0.0 – 1.0
    weight: number;
    details: string;
    status?: import('./sdk/types.js').ScorerStatus;
}

/**
 * JSON contract for deterministic scorer stdout.
 * The scorer script must print a JSON object matching this shape to stdout.
 */
export interface ScorerOutput {
    /** Score between 0.0 and 1.0 (required). Clamped by pathgrade. */
    score: number;
    /** Human-readable summary (optional). */
    details?: string;
    /** Per-check breakdown, rendered as checkmarks in reports (optional). */
    checks?: ScorerCheck[];
}

/** Individual check result within a ScorerOutput. */
export interface ScorerCheck {
    name: string;
    passed: boolean;
    message?: string;
}

export interface JudgeToolCallLogData {
    /** Tool name (readFile | listDir | grep | getToolEvents). */
    name: string;
    /** Arguments the LLM passed to the tool. */
    input: unknown;
    /** True if the tool returned content; false if it errored. */
    ok: boolean;
    /** Bytes of content returned to the LLM (0 on error). */
    bytes: number;
    /** Error message when ok is false. */
    errorMessage?: string;
    /** The owning judge scorer's name, for per-judge reporting. */
    judge_name: string;
}

export interface LogEntry {
    type: 'agent_start' | 'command' | 'agent_result' | 'scorer' | 'reward' | 'user_reply' | 'step_scorer' | 'tool_event' | 'conversation_end' | 'judge_tool_call' | 'ask_batch';
    timestamp: string;
    instruction?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    output?: string;
    assistant_message?: string;
    assistant_message_source?: VisibleAssistantMessageSource | 'blocked_prompt';
    raw_assistant_message?: string;
    value?: number;
    scorer_result?: ScorerResult;
    turn_number?: number;
    reply_source?: ConversationReplySource;
    step_scorer_key?: string;
    tool_event?: import('./tool-events.js').ToolEvent;
    judge_tool_call?: JudgeToolCallLogData;
    /**
     * @deprecated Read-only compatibility for snapshots predating the
     * blocked-prompt synthesis deletion (issue #008). New writers never emit
     * any of the `blocked_prompt_*` / `synthetic_blocked_prompt` fields, but
     * `loadRunSnapshot` still parses them so historical run-snapshots load.
     * Do not set these fields from new code paths.
     */
    synthetic_blocked_prompt?: boolean;
    /** @deprecated See `synthetic_blocked_prompt`. */
    blocked_prompt_source_turn?: number;
    /** @deprecated See `synthetic_blocked_prompt`. */
    blocked_prompt_index?: number;
    /** @deprecated See `synthetic_blocked_prompt`. */
    blocked_prompt_count?: number;
    /** @deprecated See `synthetic_blocked_prompt`. */
    blocked_prompt_source_tool?: string;
    /** @deprecated See `synthetic_blocked_prompt`. */
    blocked_prompt_tool_use_id?: string;
    runtime_policies_applied?: RuntimePolicyDescriptor[];
    /**
     * Per-turn agent cost in USD when the upstream provider reports it (the
     * Claude Agent SDK populates `total_cost_usd` on result messages).
     * Written by `buildModelAgentResultLogEntry` only when the turn result
     * carries a `costUsd` value; absent for agents that do not expose cost.
     * PRD §Token and cost telemetry; issue #003 criterion 4.
     */
    cost_usd?: number;
    completion_reason?: string;
    completion_detail?: string;
    turn_timings?: Array<{ turn: number; durationMs: number }>;
    duration_ms?: number;
    output_lines?: number;
    output_chars?: number;
    turn_details?: Array<{ turn: number; durationMs: number; outputLines: number; outputChars: number }>;
    reactions_fired?: Array<{ turn: number; reactionIndex: number; pattern: string; reply: string }>;
    // --- ask_batch variant (per RFC §Migration → asks log entry schema) ---
    /** Upstream batch identifier (ToolRequestUserInput itemId when available; synthesized for adapters without one). */
    batch_id?: string;
    /** Agent/adapter that produced the batch. */
    source?: import('./sdk/ask-bus/types.js').AskSource;
    /** Lifecycle tag; determines whether answers flow back and when. */
    lifecycle?: import('./sdk/ask-bus/types.js').AskLifecycle;
    /** Upstream tool identifier (`AskUserQuestion` | `request_user_input` | `AskQuestion`). */
    source_tool?: string;
    /** Upstream tool-use correlation id when available. */
    tool_use_id?: string;
    /** Number of questions in the batch. */
    question_count?: number;
    /** Present for 'live' batches; absent for 'post-hoc'. */
    resolved?: boolean;
}

export interface TrialResult {
    trial_id: number;
    name?: string;            // test name from the it() block
    reward: number;           // 0.0 – 1.0 weighted score
    scorer_results: ScorerResult[];
    duration_ms: number;
    n_commands: number;
    input_tokens: number;
    output_tokens: number;
    conversation_input_tokens?: number;
    conversation_output_tokens?: number;
    /**
     * Sum of agent-turn `costUsd` values accumulated during the
     * conversation, attributed at evaluation time (PRD §Token and cost
     * telemetry). Today only the Claude SDK driver populates per-turn
     * cost, so this field is set on Claude trials and absent on
     * Codex / Cursor trials. Issue #003.
     */
    conversation_cost_usd?: number;
    /**
     * Sum of all known cost components (conversation + judge + …).
     * Conservative — emitted ONLY when every included component has a
     * known cost. Today judge LLM providers do not expose cost, so this
     * field is never emitted; `conversation_cost_usd` is the only
     * guaranteed cost surface until that changes. Issue #003.
     */
    total_cost_usd?: number;
    session_log: LogEntry[];
    skills_used?: string[];
    diagnostics?: DiagnosticsReport;
    conversation?: {
        turns: ConversationTurn[];
        total_turns: number;
        completion_reason: ConversationCompletionReason;
        timeout_triggered_at_turn?: number;
    };
}

export interface EvalReport {
    task: string;
    pass_rate: number;
    pass_at_k: number;        // probability of ≥1 success in k trials
    pass_pow_k: number;       // probability of all k trials succeeding
    trials: TrialResult[];
    skills_used: string[];
}

/**
 * TrialResult with `session_log` and `conversation` stripped. These fields
 * live only in the per-group trace files; the consolidated results.json keeps
 * the rest so consumers (preview, `pathgrade report`) can compute summaries
 * without loading trace data.
 */
export type StrippedTrialResult = Omit<TrialResult, 'session_log' | 'conversation'>;

/**
 * Per-group entry in the consolidated `.pathgrade/results.json` report.
 */
export type PathgradeGroupReport = Omit<EvalReport, 'trials'> & {
    trials: StrippedTrialResult[];
    /** Relative path from `.pathgrade/` to the trace file for this group. */
    trace_file: string;
};

/**
 * Selection metadata merged into `PathgradeReport.selection` when
 * `pathgrade run --changed` produced the run. Wire shape uses `snake_case`
 * and matches the `.pathgrade/selection.json` sidecar written by the CLI.
 *
 * Reasons mirror `SelectionReason` from `src/affected/types.ts` (single
 * source of truth — new variants added there propagate here automatically).
 */
export interface PathgradeSelectionReport {
    base_ref: string;
    changed_files_count: number;
    global_match?: string;
    selected: string[];
    skipped: Array<{
        file: string;
        reason: 'no-matching-deps';
    }>;
}

/**
 * Shape of `.pathgrade/results.json` — the consolidated consolidated pathgrade
 * run report. `version` is pinned to 1 so the `pathgrade report` command and
 * external consumers can gate on schema revisions.
 */
export interface PathgradeReport {
    version: 1;
    timestamp: string;
    /** `ci.threshold` from the plugin config, if configured. */
    threshold?: number;
    /** Weighted average of every individual trial score across all groups. */
    overall_pass_rate: number;
    /**
     * Threshold check result. When `threshold` is set: `'pass'` iff
     * `overall_pass_rate >= threshold`. Otherwise: `'pass'` iff every trial
     * in every group passed its vitest test.
     */
    status: 'pass' | 'fail';
    groups: PathgradeGroupReport[];
    /**
     * Present when `pathgrade run --changed` produced the run. Absent on
     * plain `pathgrade run`. Backward compatible — older consumers ignore
     * this field.
     */
    selection?: PathgradeSelectionReport;
}

export interface TrialPaths {
    root: string;
    workspace: string;
    home: string;
    xdg?: string;
    xdgState?: string;
    xdgCache?: string;
    tmp: string;
}

export interface TrialRuntime {
    handle: string;
    workspacePath: string;
    env: Record<string, string>;
    paths?: TrialPaths;
}

export type EnvironmentHandle = string | TrialRuntime;
export type AgentCommandRunner = (cmd: string) => Promise<CommandResult>;

export interface AgentTurnInput {
    message: string;
    continueSession?: boolean;
}

export type VisibleAssistantMessageSource = 'assistant_message';

export interface AgentTurnResult {
    rawOutput: string;
    assistantMessage: string;
    visibleAssistantMessage: string;
    visibleAssistantMessageSource: VisibleAssistantMessageSource;
    exitCode: number;
    traceOutput?: string;
    timedOut?: boolean;
    toolEvents: import('./tool-events.js').ToolEvent[];
    runtimePoliciesApplied?: RuntimePolicyDescriptor[];
    inputTokens?: number;
    outputTokens?: number;
    /**
     * Optional cache-token breakdown sourced from the Claude Agent SDK's
     * `cache_creation_input_tokens` field. Additive only — `inputTokens`
     * still includes cache-creation volume, matching pathgrade's existing
     * convention (PRD §Token and cost telemetry; issue #003 criterion 8).
     */
    cacheCreationInputTokens?: number;
    /**
     * Optional cache-token breakdown sourced from the Claude Agent SDK's
     * `cache_read_input_tokens` field. Additive only — `inputTokens` still
     * includes cache-read volume.
     */
    cacheReadInputTokens?: number;
    /**
     * Optional turn cost in USD reported by providers that expose exact
     * pricing. The Claude Agent SDK populates this from the result
     * message's `total_cost_usd`. Other drivers (Codex, Cursor) leave it
     * undefined until their providers expose comparable metadata.
     * PRD §Token and cost telemetry; issue #003 User Story 18.
     */
    costUsd?: number;
    /**
     * Typed error subtype set when the turn ended in error; absent on success.
     * Lets eval consumers triage failures correctly without regex on the
     * result text. PRD §Token and cost telemetry; issue #003 User Story 19.
     *
     * The `error_*` values are SDK-reported result subtypes (`SDKResultError`
     * per `sdk.d.ts`). `'bus_rejection'` is driver-synthesized: when the live
     * ask-user bridge captures a bus error (timeout, missing subscriber,
     * subscriber throw), the Claude SDK driver constructs an error
     * `AgentTurnResult` with this subtype rather than throwing, so the
     * partial-turn observability pipeline (`ask_batch`, `model_agent_result`,
     * turn timings/details) captures the rejected turn before the runner
     * propagates the error. The naming distinction (no `error_` prefix)
     * marks the layer of origin: SDK vs driver.
     */
    errorSubtype?:
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries'
        | 'bus_rejection';
    /**
     * Populated when the agent subprocess died mid-turn under a stateful
     * transport (Codex `app-server`). Consumers should translate this into
     * `ConversationResult.crashDiagnostic` via `AgentCrashError`.
     */
    crashInfo?: {
        pid?: number;
        signal?: ProcessSignal | string | null;
        exitCode?: number | null;
    };
}

export interface AgentSession {
    start(input: AgentTurnInput): Promise<AgentTurnResult>;
    reply(input: AgentTurnInput): Promise<AgentTurnResult>;
    /**
     * Optional explicit teardown hook. Drivers that hold OS resources
     * (subprocess, stdio pipes, long-lived promises) implement this so session
     * wrappers can release them in a `finally` block. Must be idempotent and
     * safe to call before any turn was ever run.
     */
    dispose?(): Promise<void>;
}

export function getWorkspacePath(handle: EnvironmentHandle): string {
    return typeof handle === 'string' ? handle : handle.workspacePath;
}

export function getRuntimeHandle(handle: EnvironmentHandle): string {
    return typeof handle === 'string' ? handle : handle.handle;
}

export function getRuntimeEnv(handle: EnvironmentHandle): Record<string, string> {
    return typeof handle === 'string' ? {} : handle.env;
}

export interface AgentSessionOptions {
    mcpConfigPath?: string;
    model?: string;
    conversationWindow?: import('./sdk/types.js').ConversationWindowConfig | false;
    runtimePolicies?: RuntimePolicyDescriptor[];
    /** LLM port for conversation window summarization. */
    llm?: LLMPort;
    /**
     * Codex transport. Claude/Cursor ignore this. When `'app-server'`, the
     * Codex driver swaps to the reliable ask-user channel. Resolved by
     * `createManagedSession`; option/env plumbing that feeds it lands in slice #7.
     */
    transport?: import('./sdk/types.js').AgentTransport;
    /**
     * Per-conversation bus through which adapters emit ask_user question
     * batches and subscribers respond. Constructed by `createManagedSession`.
     * Drivers emitting `lifecycle: 'live'` batches (Codex app-server) MUST
     * enforce presence via `requireAskBusForLiveBatches`; adapters emitting
     * only `lifecycle: 'post-hoc'` no-op when absent.
     */
    askBus?: import('./sdk/ask-bus/types.js').AskBus;
}

export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        // Default: wrap run() into a session for simple agents
        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const rawOutput = await this.run(message, getWorkspacePath(runtime), runCommand);
            return {
                rawOutput,
                assistantMessage: rawOutput,
                visibleAssistantMessage: rawOutput,
                visibleAssistantMessageSource: 'assistant_message',
                exitCode: 0,
                traceOutput: rawOutput,
                toolEvents: [],
                runtimePoliciesApplied: [],
            };
        };
        return {
            start: async ({ message }) => runTurn(message),
            reply: async ({ message }) => runTurn(message),
        };
    }

    run(
        _instruction: string,
        _workspacePath: string,
        _runCommand: AgentCommandRunner
    ): Promise<string> {
        throw new Error('Agent must implement createSession() or run()');
    }
}

export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner,
    options?: AgentSessionOptions
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand, options);
}
