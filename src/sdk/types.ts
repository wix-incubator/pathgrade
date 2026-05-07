import type { CommandResult, LogEntry } from '../types.js';
import type { ToolAction } from '../tool-events.js';
import type { MockMcpServerDescriptor } from '../core/mcp-mock.types.js';
import type { TrialResult } from '../types.js';
import type { DiagnosticsReport } from '../reporters/diagnostics.js';
import type { LLMPort } from '../utils/llm-types.js';

type ProcessSignal = string;

// --- Agent ---

export type AgentName = 'claude' | 'codex' | 'cursor';

// --- Agent ---

export interface AgentOptions {
    agent?: AgentName;                   // default: 'claude' (or PATHGRADE_AGENT env)
    model?: string;                     // agent model override; Codex defaults to an explicit CLI model
    timeout?: number | 'auto';           // seconds, default: 300; 'auto' supported by runConversation() only
    workspace?: string;
    skillDir?: string;
    copyFromHome?: string[];
    env?: Record<string, string>;
    mcpMock?: MockMcpServerDescriptor | MockMcpServerDescriptor[];
    /** Configure the conversation window for transcript-based agents. Set false to disable. */
    conversationWindow?: ConversationWindowConfig | false;
    /** Copy workspace to a persistent location before cleanup. true = ./pathgrade-debug/{test-name}/, string = custom path. */
    debug?: boolean | string;
    /**
     * Glob patterns to ignore when copying workspace and skill directories.
     * Replaces the default ignore list entirely. Pass `[]` to disable filtering.
     * When omitted, DEFAULT_COPY_IGNORE is used.
     */
    copyIgnore?: string[];
    /**
     * Codex-only transport override. Precedence:
     *   `opts.transport` > `PATHGRADE_CODEX_TRANSPORT` env > `'app-server'`
     * Invalid env values throw at `createAgent` time. Ignored for other agents
     * in v1 (documented but not enforced).
     */
    transport?: AgentTransport;
}

export interface ConversationWindowConfig {
    /** Number of recent messages to keep verbatim. Default: 4 */
    windowSize?: number;
    /** Model for summarization. Default: 'claude-haiku-4-5-20251001' */
    model?: string;
}

export interface Message {
    role: 'user' | 'agent';
    content: string;
}

export interface Agent {
    prompt(message: string): Promise<string>;
    runConversation(opts: ConverseOptions): Promise<ConversationResult>;
    startChat(firstMessage: string): Promise<ChatSession>;
    exec(cmd: string): Promise<CommandResult>;
    transcript(): string;
    readonly llm: LLMPort;
    readonly messages: Message[];
    readonly log: LogEntry[];
    readonly workspace: string;
    dispose(): Promise<void>;
}

// --- Conversation (stubs for Issue 3/4, not implemented yet) ---

export interface ConverseOptions {
    firstMessage: string;
    maxTurns?: number;
    until?: UntilPredicate;
    reactions?: Reaction[];
    persona?: PersonaConfig;
    stepScorers?: StepScorer[];
    /**
     * Conversation-level ceiling (ms) for a single live `ask_user` batch to
     * resolve. When the reaction engine can't produce an answer within this
     * window, `handle.resolution` rejects and the turn ends with
     * `completionReason: 'error'`. Default `30_000`.
     */
    askUserTimeoutMs?: number;
    /**
     * Disposition when a live `ask_user` batch has no matching
     * `AskUserReaction` (or a matching reaction's `answer` returns `undefined`):
     * - `'error'` (default): the bus is responded to with `source: 'declined'`
     *   so the handle resolves; the turn then ends with `completionReason:
     *   'error'` and `completionDetail: 'unmatched ask_user on turn N: <id>'`.
     * - `'first-option'`: pick `options[0].label`. Free-text (`options: null`)
     *   and `isSecret: true` questions degrade to `'error'`.
     * - `'decline'`: emit `{ values: [], source: 'declined' }` for the
     *   question. The turn continues normally.
     */
    onUnmatchedAskUser?: 'error' | 'first-option' | 'decline';
    /**
     * When the configured transport cannot deliver `AskUserReaction`s mid-turn
     * (e.g. `codex` transport: `'exec'`), pathgrade's runtime-policy guard
     * refuses to start the session. Set to `true` to silence that guard —
     * reactions will simply never fire for that agent/transport combo.
     * Validation lives in runtime-policy (slices #3/#7); this field is the
     * ConverseOptions plumbing point.
     */
    allowUnreachableReactions?: boolean;
}

export type UntilPredicate = (ctx: UntilContext) => boolean | Promise<boolean>;

export interface UntilContext {
    turn: number;
    lastMessage: string;
    workspace: string;
    messages: Message[];
    hasFile: (glob: string) => Promise<boolean>;
}

/**
 * Free-text reaction. When the agent's assistant message matches `when`
 * (and does not match `unless`), `reply` is sent as the next user message.
 * Also kept as a compatibility answer for structured ask_user questions:
 * when no `AskUserReaction` answers a matching question, `reply` is used as
 * that question's answer.
 * Shape is byte-identical to the pre-discriminated-union Reaction.
 */
export interface TextReaction {
    when: RegExp;
    unless?: RegExp;
    reply: string;
    once?: boolean;
}

/** Structured-question option (mirrors upstream `Option` shape; no `id`). */
export interface AskUserOption {
    label: string;
    description?: string;
}

/** Pathgrade-local mirror of upstream AskUserQuestion shape. */
export interface AskUserQuestion {
    id: string;
    header?: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: AskUserOption[] | null;
}

/**
 * Structured ask_user reaction. Fires only on ask_user handshake turns
 * (post-hoc Claude denials and live Codex app-server requests). Never
 * evaluated against assistant free text. `answer` returning `undefined`
 * falls through to the next matching reaction, then to `onUnmatchedAskUser`.
 */
export interface AskUserReaction {
    whenAsked: RegExp | ((question: AskUserQuestion) => boolean);
    answer: string | string[] | ((question: AskUserQuestion) => string | string[] | undefined);
    once?: boolean;
}

export type Reaction = TextReaction | AskUserReaction;

export type ReactionPreviewStatus = 'fired' | 'vetoed' | 'no-match' | 'shadowed';

export interface TextReactionPreviewEntry {
    kind: 'text';
    reactionIndex: number;
    whenMatched: boolean;
    unlessMatched: boolean;
    fired: boolean;
    status: ReactionPreviewStatus;
    reply?: string;
}

export interface AskUserReactionPreviewEntry {
    kind: 'ask_user';
    reactionIndex: number;
    whenAskedMatched: boolean;
    resolvedAnswers?: string[];
    fired: boolean;
    status: ReactionPreviewStatus;
}

export type ReactionPreviewEntry = TextReactionPreviewEntry | AskUserReactionPreviewEntry;

export interface ReactionPreviewTurn {
    turn: number;
    agentMessage: string;
    reactions: ReactionPreviewEntry[];
}

export interface ReactionPreviewResult {
    turns: ReactionPreviewTurn[];
}

export interface StepScorer {
    afterTurn: number;
    scorers: Scorer[];
}

export interface ChatSession {
    readonly turn: number;
    readonly done: boolean;
    readonly lastMessage: string;
    readonly messages: Message[];
    reply(message: string): Promise<void>;
    hasFile(glob: string): Promise<boolean>;
    end(): void;
}

export interface TurnTiming {
    turn: number;
    durationMs: number;
}

export interface TurnDetail {
    turn: number;
    durationMs: number;
    outputLines: number;
    outputChars: number;
}

export interface ReactionFiredEntry {
    turn: number;
    reactionIndex: number;
    pattern: string;
    reply: string;
}

export interface ConversationResult {
    turns: number;
    completionReason: 'until' | 'maxTurns' | 'noReply' | 'timeout' | 'error' | 'agent_crashed';
    completionDetail?: string;
    turnTimings: TurnTiming[];
    turnDetails?: TurnDetail[];
    reactionsFired?: ReactionFiredEntry[];
    stepResults: Array<{ afterTurn: number; result: EvalResult }>;
    /**
     * Subprocess-crash diagnostic, present only when `completionReason` is
     * `'agent_crashed'`. `partialAsks` is sourced from `askBus.snapshot()` so
     * `isSecret` answers are already bus-redacted. `partialToolEvents`
     * narrows to non-ask-user events — ask-user events derive from
     * `partialAsks` via `toAskUserToolEvent` at reporter/log time.
     */
    crashDiagnostic?: {
        pid?: number;
        signal?: ProcessSignal | null;
        exitCode?: number | null;
        lastTurnNumber: number;
        partialAsks: readonly import('./ask-bus/types.js').AskBatchSnapshot[];
        partialToolEvents: import('../tool-events.js').ToolEvent[];
    };
}

export interface Persona {
    reply(chat: ChatSession): Promise<string>;
}

export interface PersonaConfig {
    description: string;
    facts: string[];
    model?: string;
    /** LLM port for persona and summarization calls. */
    llm?: LLMPort;
    /** Configure the conversation window for persona history. Set false to disable. */
    conversationWindow?: ConversationWindowConfig | false;
}

// --- Grading ---

export type Scorer = CheckScorer | ScoreScorer | JudgeScorer | ToolUsageScorer;

export interface CheckScorer {
    type: 'check';
    name: string;
    weight: number;
    fn: (ctx: ScorerContext) => boolean | Promise<boolean>;
}

export interface ScoreScorer {
    type: 'score';
    name: string;
    weight: number;
    fn: (ctx: ScorerContext) => number | ScoreResult | Promise<number | ScoreResult>;
}

export interface ScoreResult {
    score: number;
    details?: string;
}

export type JudgeInput =
    | Record<string, unknown>
    | ((ctx: ScorerContext) => Record<string, unknown> | Promise<Record<string, unknown>>);

export type CodeJudgeToolName = 'readFile' | 'listDir' | 'grep' | 'getToolEvents';

export interface JudgeScorer {
    type: 'judge';
    name: string;
    weight: number;
    rubric: string;
    model?: string;
    retry?: boolean | number;
    includeToolEvents?: boolean;
    input?: JudgeInput;
    /** Opt-in allowlist of tools the judge LLM may call. Non-empty = tool-use loop. */
    tools?: CodeJudgeToolName[];
    /** Cap on LLM calls per judge; default 10. */
    maxRounds?: number;
    /** Enable Anthropic prompt caching for system + tool schemas. Default: true when tools is set. */
    cacheControl?: boolean;
}

export interface ToolExpectation {
    action: ToolAction;
    min?: number;
    max?: number;
    path?: string;
    commandContains?: string;
    argumentPattern?: string;
    toolName?: string;
    weight?: number;
}

export interface ToolUsageScorer {
    type: 'tool_usage';
    name: string;
    weight: number;
    expectations: ToolExpectation[];
}

export interface SessionArtifactMatchOptions {
    actions?: import('../tool-events.js').ToolAction[];
    pattern?: string | RegExp;
}

export interface SessionArtifactContent {
    path: string;
    content: string;
}

export interface SessionArtifacts {
    list: (opts?: SessionArtifactMatchOptions) => string[];
    read: (path: string) => Promise<string>;
    latest: (opts?: SessionArtifactMatchOptions) => Promise<SessionArtifactContent | null>;
}

export interface ScorerContext {
    workspace: string;
    log: LogEntry[];
    transcript: string;
    toolEvents: import('../tool-events.js').ToolEvent[];
    runCommand: (cmd: string) => Promise<CommandResult>;
    artifacts: SessionArtifacts;
}

export interface EvaluateOptions {
    failFast?: boolean;
    llm?: LLMPort;
    onScorerError?: 'skip' | 'zero' | 'fail';
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

export type ScorerStatus = 'ok' | 'error' | 'skipped';

export interface EvalResult {
    score: number;
    scorers: ScorerResultEntry[];
    tokenUsage?: TokenUsage;  // real token usage from LLM providers
}

export interface RecordedEvalResult extends EvalResult {
    trial?: TrialResult;
}

export interface ScorerResultEntry {
    name: string;
    type: 'check' | 'score' | 'judge' | 'tool_usage';
    score: number;
    weight: number;
    details?: string;
    status?: ScorerStatus;
    /**
     * Machine-readable failure code for judge scorers that support a
     * failure taxonomy (currently only tool-using judges).
     * One of: llm_refused | max_rounds | invalid_score | tool_error_unrecoverable | provider_not_supported
     */
    errorCode?: string;
}

export interface PathgradeTestMeta {
    score: number;
    scorers: ScorerResultEntry[];
    trial?: TrialResult;
    diagnostics?: DiagnosticsReport;
}

// --- Agent Capabilities ---

export interface AgentCapabilities {
    mcp: boolean;
    nativeSession: boolean;
    interactiveQuestionTransport: 'reliable' | 'noninteractive';
}

/**
 * Codex-specific transport. Claude and Cursor ignore this.
 * `app-server` unlocks `interactiveQuestionTransport: 'reliable'` for Codex;
 * `exec` (the default) keeps the `'noninteractive'` channel.
 */
export type AgentTransport = 'exec' | 'app-server';

const BASE_CAPABILITIES: Record<AgentName, AgentCapabilities> = {
    claude: { mcp: true, nativeSession: true, interactiveQuestionTransport: 'reliable' },
    codex: { mcp: false, nativeSession: true, interactiveQuestionTransport: 'noninteractive' },
    cursor: { mcp: true, nativeSession: true, interactiveQuestionTransport: 'noninteractive' },
};

export function getAgentCapabilities(
    agent: AgentName,
    transport?: AgentTransport,
): AgentCapabilities {
    const base = BASE_CAPABILITIES[agent];
    if (agent === 'codex' && transport === 'app-server') {
        return { ...base, interactiveQuestionTransport: 'reliable' };
    }
    return base;
}

/**
 * @deprecated Use `getAgentCapabilities(agent, transport?)` instead. Kept as
 * an internal read only during the transport-swap migration.
 */
export const AGENT_CAPABILITIES: Record<AgentName, AgentCapabilities> = BASE_CAPABILITIES;

// --- Plugin ---

export interface PathgradePluginOptions {
    include?: string[];
    exclude?: string[];
    timeout?: number;               // seconds, default: 300
    reporter?: 'cli' | 'browser' | 'json';
    diagnostics?: boolean;
    /**
     * Stream live per-turn events (turn start/end, tool calls, reactions,
     * blocked prompts, conversation end) to stderr while evals run. Off by
     * default. CLI `--verbose` / `PATHGRADE_VERBOSE=1` take precedence over
     * this option: the plugin only sets `PATHGRADE_VERBOSE=1` if it is not
     * already set by the user's shell or the CLI wrapper. See
     * `docs/prds/PRD_VERBOSE_LIVE_STREAMING.md`.
     */
    verbose?: boolean;
    scorerModel?: string;
    ci?: {
        threshold?: number;
    };
    /**
     * Affected-eval-selection configuration. Consumed by the `pathgrade affected`
     * and `pathgrade run --changed` CLI commands (not by the plugin itself at
     * runtime — selection is a pre-vitest filter).
     */
    affected?: {
        /**
         * Repo-level "rerun everything" triggers. When any changed file
         * matches any glob here, selection short-circuits and every discovered
         * eval is selected. Keep small — every match defeats the feature's
         * purpose. See PRD §"Root-level `global` config".
         */
        global?: string[];
    };
}

/**
 * Per-eval selection metadata. Export from an `.eval.ts` as a named
 * top-level constant to declare dependency globs or opt into always-run
 * behavior. Pathgrade extracts this via AST — the eval module is NOT
 * executed during selection, so the value must be a literal expression.
 *
 * See PRD §"Overrides and extras: `__pathgradeMeta`".
 *
 * Note: `onMissing` is intentionally *not* a field here — it names the
 * pathgrade runtime's behavior when `__pathgradeMeta` is entirely absent
 * AND there is no SKILL.md ancestor (fail-closed rerun with warning).
 */
export interface PathgradeMeta {
    /** Full override: replaces auto-detected `<skillRoot>/**`. */
    deps?: string[];
    /** Unioned with the auto-detected skill root (or with `deps`). */
    extraDeps?: string[];
    /** Unconditionally include this eval in every `pathgrade run --changed`. */
    alwaysRun?: boolean;
}
