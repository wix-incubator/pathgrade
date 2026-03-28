/**
 * Eval configuration types.
 *
 * These types define the schema for the eval.ts config that developers
 * create to define evaluation tasks for their skills.
 */

/** Supported agent names — single source of truth for both type and runtime validation */
export const VALID_AGENTS = ['claude', 'gemini', 'codex'] as const;
export type AgentName = typeof VALID_AGENTS[number];

/** Task execution mode */
export type TaskMode = 'conversation' | 'instruction';

/** Workspace file mapping: copy a local file into the trial workspace */
export interface WorkspaceMapping {
    src: string;        // relative to eval.ts
    dest: string;       // path in the trial workspace
    chmod?: string;     // e.g. "+x"
}

/** Workspace directory mapping: mirror an entire directory into the trial workspace */
export interface WorkspaceDirectoryMapping {
    dir: string;        // directory path relative to eval.ts — all files mirrored
    chmod?: string;     // e.g. "+x", applied to all files
}

/** A single workspace entry: either a file mapping or a directory to mirror */
export type WorkspaceEntry = WorkspaceMapping | WorkspaceDirectoryMapping;

export interface ConversationReactionConfig {
    when: string;           // regex pattern (compiled with 'i' flag)
    reply: string;          // response content (inline or file path)
    once?: boolean;         // if true, reaction is consumed after first use (default: false)
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
    done_when?: string;     // semantic completion — LLM judges if condition is met
    timeout?: number;
}

export type { GraderDescriptor, GraderContext } from './grader-factories';
import type { GraderDescriptor } from './grader-factories';

/** Graders that run at intermediate conversation steps */
export interface StepGraderConfig {
    after_turn: number;       // 1-indexed turn number
    graders: GraderDescriptor[];
}

export interface ConversationConfig {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies?: ConversationReplyConfig[]
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}

export interface ResolvedConversationReaction {
    when: string;
    reply: string;
    once?: boolean;
}

export interface ResolvedStepGrader {
    after_turn: number;
    graders: GraderDescriptor[];
}

export interface ResolvedConversation {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ResolvedConversationReaction[];  // was: replies?: ResolvedConversationReply[]
    persona?: ConversationPersonaConfig;
    step_graders?: ResolvedStepGrader[];
}

/** Supported grader types — single source of truth */
export const VALID_GRADER_TYPES = ['deterministic', 'llm_rubric', 'tool_usage'] as const;
export type GraderType = typeof VALID_GRADER_TYPES[number];

/** Tool-usage expectation for the tool_usage grader */
export interface ToolUsageExpectation {
    action: import('../tool-events').ToolAction;
    min?: number;
    max?: number;
    provider?: AgentName;
    path?: string;
    command_contains?: string;
    argument_pattern?: string;  // regex tested against all string values in arguments
    tool_name?: string;
    weight?: number;
}


/** Environment resource limits */
export interface EnvironmentConfig {
    cpus: number;
    memory_mb: number;
}

/** Shared fields for all task types */
interface EvalTaskBase {
    name: string;
    workspace?: WorkspaceEntry[];
    graders: GraderDescriptor[];
    solution?: string;
    agent?: AgentName;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
}

/** Instruction task — agent receives a one-shot instruction */
export interface InstructionTaskConfig extends EvalTaskBase {
    type: 'instruction';
    instruction: string;
}

/** Conversation task — agent participates in multi-turn dialogue */
export interface ConversationTaskConfig extends EvalTaskBase {
    type: 'conversation';
    conversation: ConversationConfig;
}

/** Single eval task (discriminated union) */
export type EvalTaskConfig = InstructionTaskConfig | ConversationTaskConfig;

/** Top-level defaults */
export interface EvalDefaults {
    agent: AgentName;
    trials: number;
    timeout: number;
    threshold: number;  // for --ci mode
    grader_model?: string;  // default LLM grader model
    environment: EnvironmentConfig;
}

/** Top-level eval config */
export interface EvalConfig {
    version: string;
    skillPath?: string;     // optional path to SKILL.md (defaults to auto-detection)
    defaults: EvalDefaults;
    tasks: EvalTaskConfig[];
}

/** Shared resolved fields */
interface ResolvedTaskBase {
    name: string;
    workspace: WorkspaceMapping[];
    graders: GraderDescriptor[];
    solution?: string;
    agent: AgentName;
    trials: number;
    timeout: number;
    grader_model?: string;
    environment: EnvironmentConfig;
}

export interface ResolvedInstructionTask extends ResolvedTaskBase {
    type: 'instruction';
    instruction: string;
}

export interface ResolvedConversationTask extends ResolvedTaskBase {
    type: 'conversation';
    conversation: ResolvedConversation;
}

export type ResolvedTask = ResolvedInstructionTask | ResolvedConversationTask;


export interface DefineEvalConversationInput {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies?: ConversationReplyConfig[]
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}

/** Shared fields for defineEval task input */
interface DefineEvalTaskBase {
    name: string;
    workspace?: (string | WorkspaceMapping | WorkspaceDirectoryMapping)[];
    graders: GraderDescriptor[];
    solution?: string;
    agent?: AgentName;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
}

export interface DefineEvalInstructionTaskInput extends DefineEvalTaskBase {
    type: 'instruction';
    instruction: string;
}

export interface DefineEvalConversationTaskInput extends DefineEvalTaskBase {
    type: 'conversation';
    conversation: DefineEvalConversationInput;
}

export type DefineEvalTaskInput = DefineEvalInstructionTaskInput | DefineEvalConversationTaskInput;

export interface DefineEvalInput {
    version?: string;           // defaults to '1'
    skillPath?: string;
    defaults?: Partial<EvalDefaults>;
    tasks: DefineEvalTaskInput[];
}
