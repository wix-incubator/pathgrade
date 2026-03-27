import type { GraderOutput, GraderCheck, CommandResult, LogEntry } from '../types';
import type { ToolUsageExpectation, GraderType } from './config.types';

export interface GraderContext {
    /** Absolute path to the trial workspace */
    workspacePath: string;
    /** Run a shell command in the workspace */
    runCommand: (cmd: string) => Promise<CommandResult>;
    /** Full session log (commands, tool events, agent output, etc.) */
    sessionLog: LogEntry[];
    /** Environment variables */
    env: Record<string, string>;
    /** Abort signal for timeout handling */
    signal?: AbortSignal;
}

export interface GraderDescriptor {
    type: GraderType;
    weight: number;
    /** Deterministic: user-provided grading logic */
    execute?: (ctx: GraderContext) => Promise<GraderOutput>;
    /** LLM rubric: inline text or file path */
    rubric?: string;
    /** LLM rubric: model override */
    model?: string;
    /** LLM rubric: include tool events in transcript */
    include_tool_events?: boolean;
    /** Tool usage: declarative expectations */
    expectations?: ToolUsageExpectation[];
}

export function deterministicGrader(opts: {
    weight?: number;
    execute: (ctx: GraderContext) => Promise<GraderOutput>;
}): GraderDescriptor {
    return {
        type: 'deterministic',
        weight: opts.weight ?? 1.0,
        execute: opts.execute,
    };
}

export function llmRubricGrader(opts: {
    weight?: number;
    rubric: string;
    model?: string;
    include_tool_events?: boolean;
}): GraderDescriptor {
    return {
        type: 'llm_rubric',
        weight: opts.weight ?? 1.0,
        rubric: opts.rubric,
        model: opts.model,
        include_tool_events: opts.include_tool_events,
    };
}

export function toolUsageGrader(opts: {
    weight?: number;
    expectations: ToolUsageExpectation[];
}): GraderDescriptor {
    return {
        type: 'tool_usage',
        weight: opts.weight ?? 1.0,
        expectations: opts.expectations,
    };
}
