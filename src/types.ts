export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    killed?: boolean;
}

export interface CommandExecutionOptions {
    signal?: AbortSignal;
}

export interface TurnCommand extends CommandResult {
    command: string;
}

export type ConversationReplySource = 'opener' | 'scripted' | 'scripted_pattern' | 'persona_llm';

export interface ConversationTurn {
    turn_number: number;
    user_message: string;
    user_message_source: ConversationReplySource;
    raw_agent_output: string;
    assistant_message: string;
    duration_ms: number;
    commands: TurnCommand[];
    turn_status: 'completed' | 'error' | 'timeout';
    step_grader_results?: GraderResult[];
    tool_events?: import('./tool-events').ToolEvent[];
}

export type ConversationCompletionReason =
    | 'max_turns'
    | 'signal'
    | 'done_phrase'
    | 'done_when'
    | 'timeout'
    | 'no_replies'
    | 'error';

export interface GraderConfig {
    type: 'deterministic' | 'llm_rubric';
    command?: string;         // for deterministic: shell command to execute (e.g. 'bash tests/test.sh')
    rubric?: string;          // for llm_rubric: file path to rubric (e.g. 'prompts/quality.md')
    model?: string;           // for llm_rubric: LLM model override
    weight: number;
}

export interface GraderResult {
    grader_type: string;
    score: number;      // 0.0 – 1.0
    weight: number;
    details: string;
}

/**
 * JSON contract for deterministic grader stdout.
 * The grader script must print a JSON object matching this shape to stdout.
 */
export interface GraderOutput {
    /** Score between 0.0 and 1.0 (required). Clamped by pathgrade. */
    score: number;
    /** Human-readable summary (optional). */
    details?: string;
    /** Per-check breakdown, rendered as checkmarks in reports (optional). */
    checks?: GraderCheck[];
}

/** Individual check result within a GraderOutput. */
export interface GraderCheck {
    name: string;
    passed: boolean;
    message?: string;
}

export interface LogEntry {
    type: 'agent_start' | 'command' | 'agent_result' | 'grader' | 'reward' | 'user_reply' | 'step_grader' | 'tool_event';
    timestamp: string;
    instruction?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    output?: string;
    assistant_message?: string;
    value?: number;
    grader_result?: GraderResult;
    turn_number?: number;
    reply_source?: ConversationReplySource;
    step_grader_key?: string;
    tool_event?: import('./tool-events').ToolEvent;
}

export interface TrialResult {
    trial_id: number;
    reward: number;           // 0.0 – 1.0 weighted score
    grader_results: GraderResult[];
    duration_ms: number;
    n_commands: number;
    input_tokens: number;     // estimated from instruction length
    output_tokens: number;    // estimated from agent output
    persona_input_tokens?: number;
    persona_output_tokens?: number;
    session_log: LogEntry[];
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
export type AgentCommandRunner = (cmd: string, options?: CommandExecutionOptions) => Promise<CommandResult>;

export interface AgentTurnInput {
    message: string;
    continueSession?: boolean;
}

export interface AgentTurnResult {
    rawOutput: string;
    assistantMessage: string;
    exitCode: number;
    traceOutput?: string;
}

export interface AgentSession {
    start(input: AgentTurnInput): Promise<AgentTurnResult>;
    reply(input: AgentTurnInput): Promise<AgentTurnResult>;
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

export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        // Default: wrap run() into a session for simple agents
        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const rawOutput = await this.run(message, getWorkspacePath(runtime), runCommand);
            return { rawOutput, assistantMessage: rawOutput, exitCode: 0, traceOutput: rawOutput };
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
    runCommand: AgentCommandRunner
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand);
}

/** Options passed to environment providers for setup */
export interface EnvironmentSetupOpts {
    timeoutSec: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    /**
     * 'host' — preserve real HOME for CLI auth (host-auth passthrough).
     *          Workspace is still isolated via cwd.
     * 'isolated' — override HOME with temp dir (current default behavior).
     */
    authMode?: 'host' | 'isolated';
}

export interface EnvironmentProvider {
    /** One-time setup: build image, inject skills. Returns reusable handle. */
    prepare?(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, env?: Record<string, string>): Promise<string>;
    /** Per-trial setup: create isolated workspace. */
    setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, env?: Record<string, string>): Promise<EnvironmentHandle>;
    /** Per-trial cleanup. */
    cleanup(workspacePath: EnvironmentHandle): Promise<void>;
    /** One-time teardown. */
    teardown?(): Promise<void>;
    runCommand(
        workspacePath: EnvironmentHandle,
        command: string,
        env?: Record<string, string>,
        options?: CommandExecutionOptions
    ): Promise<CommandResult>;
    diagnose?(workspacePath: EnvironmentHandle): Promise<string>;
}
