/**
 * eval.yaml configuration types.
 *
 * These types define the schema for the eval.yaml file that developers
 * create to define evaluation tasks for their skills.
 */

/** Workspace file mapping: copy a local file into the trial workspace */
export interface WorkspaceMapping {
    src: string;        // relative to eval.yaml
    dest: string;       // path in the trial workspace
    chmod?: string;     // e.g. "+x"
}

export interface ConversationReplyConfig {
    content: string;
    when?: string;
}

export interface ConversationPersonaConfig {
    description: string;
    facts: string[];
    model?: string;
}

export interface ConversationCompletionConfig {
    max_turns: number;
    signal?: string;
    done_phrase?: string;
    timeout?: number;
}

/** Graders that run at intermediate conversation steps */
export interface StepGraderConfig {
    after_turn: number;       // 1-indexed turn number
    graders: EvalGraderConfig[];
}

export interface ConversationConfig {
    opener: string;
    completion: ConversationCompletionConfig;
    replies?: ConversationReplyConfig[];
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}

export interface ResolvedConversationReply {
    content: string;
    when?: string;
}

export interface ResolvedStepGrader {
    after_turn: number;
    graders: ResolvedGrader[];
}

export interface ResolvedConversation {
    opener: string;
    completion: ConversationCompletionConfig;
    replies?: ResolvedConversationReply[];
    persona?: ConversationPersonaConfig;
    step_graders?: ResolvedStepGrader[];
}

/** Grader definition */
export interface EvalGraderConfig {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;     // commands to install grader dependencies (runs during image build)
    run?: string;       // inline script or file path (deterministic)
    rubric?: string;    // inline rubric or file path (llm_rubric)
    model?: string;     // LLM model override (e.g. 'gemini-2.0-flash', 'claude-sonnet-4-20250514')
    weight: number;
}

/** Environment resource limits */
export interface EnvironmentConfig {
    cpus: number;
    memory_mb: number;
}

/** Single eval task */
export interface EvalTaskConfig {
    name: string;
    instruction?: string;   // inline text or path to .md file
    conversation?: ConversationConfig;
    workspace?: WorkspaceMapping[];
    graders: EvalGraderConfig[];
    solution?: string;      // path to reference solution script

    // Per-task overrides
    agent?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
}

/** Top-level defaults */
export interface EvalDefaults {
    agent: string;      // 'gemini' | 'claude' | 'codex'
    trials: number;
    timeout: number;
    threshold: number;  // for --ci mode
    grader_model?: string;  // default LLM grader model
    environment: EnvironmentConfig;
}

/** Top-level eval.yaml */
export interface EvalConfig {
    version: string;
    skill?: string;         // optional path to SKILL.md (defaults to auto-detection)
    defaults: EvalDefaults;
    tasks: EvalTaskConfig[];
}

/** Resolved task — all defaults applied, file references resolved to content */
export interface ResolvedTask {
    name: string;
    instruction?: string;   // actual content (not file path)
    conversation?: ResolvedConversation;
    workspace: WorkspaceMapping[];
    graders: ResolvedGrader[];
    solution?: string;      // resolved file path
    agent: string;
    trials: number;
    timeout: number;
    grader_model?: string;  // inherited default model for LLM graders
    environment: EnvironmentConfig;
}

export interface ResolvedGrader {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;     // resolved setup commands
    run?: string;       // resolved content for deterministic
    rubric?: string;    // resolved content for llm_rubric
    model?: string;     // LLM model override
    weight: number;
}

/** User-friendly input for defineEval() — all defaults are optional */
export interface DefineEvalGraderInput {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;
    run?: string;
    rubric?: string;
    model?: string;
    weight?: number;    // defaults to 1.0
}

export interface DefineEvalConversationInput {
    opener: string;
    completion: ConversationCompletionConfig;
    replies?: ConversationReplyConfig[];
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}

export interface DefineEvalTaskInput {
    name: string;
    instruction?: string;
    conversation?: DefineEvalConversationInput;
    workspace?: WorkspaceMapping[];
    graders: DefineEvalGraderInput[];
    solution?: string;
    agent?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
}

export interface DefineEvalInput {
    version?: string;           // defaults to '1'
    skill?: string;
    defaults?: Partial<EvalDefaults>;
    tasks: DefineEvalTaskInput[];
}
