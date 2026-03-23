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

export type ConversationReplySource = 'opener' | 'scripted' | 'scripted_pattern';

export interface ConversationTurn {
    turn_number: number;
    user_message: string;
    user_message_source: ConversationReplySource;
    raw_agent_output: string;
    assistant_message: string;
    duration_ms: number;
    commands: TurnCommand[];
    turn_status: 'completed' | 'error' | 'timeout';
}

export type ConversationCompletionReason =
    | 'max_turns'
    | 'signal'
    | 'done_phrase'
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

export interface LogEntry {
    type: 'agent_start' | 'command' | 'agent_result' | 'grader' | 'reward' | 'user_reply';
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
}

export interface TrialResult {
    trial_id: number;
    reward: number;           // 0.0 – 1.0 weighted score
    grader_results: GraderResult[];
    duration_ms: number;
    n_commands: number;
    input_tokens: number;     // estimated from instruction length
    output_tokens: number;    // estimated from agent output
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
    xdg: string;
    xdgState: string;
    xdgCache: string;
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

export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner
): Promise<AgentSession> {
    if (
        typeof (agent as any).createSession === 'function' &&
        (agent as any).createSession !== BaseAgent.prototype.createSession
    ) {
        return await (agent as any).createSession(runtime, runCommand);
    }

    if (typeof (agent as any).run === 'function') {
        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const rawOutput = await (agent as any).run(message, getWorkspacePath(runtime), runCommand);
            return {
                rawOutput,
                assistantMessage: rawOutput,
                exitCode: 0,
            };
        };

        return {
            start: async ({ message }) => runTurn(message),
            reply: async ({ message }) => runTurn(message),
        };
    }

    throw new Error('Agent must implement createSession() or run()');
}

export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        return createAgentSession(this, runtime, runCommand);
    }

    abstract run(
        instruction: string,
        workspacePath: string,
        runCommand: AgentCommandRunner
    ): Promise<string>;
}

/** Options passed to environment providers for setup */
export interface EnvironmentSetupOpts {
    timeoutSec: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
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
