/**
 * Parser and validator for eval config files (*.eval.ts).
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    ConversationConfig,
    ResolvedConversation,
    ResolvedStepGrader,
    WorkspaceMapping,
    WorkspaceEntry,
    EnvironmentConfig,
    AgentName,
    VALID_AGENTS,
} from './config.types';
import type { GraderDescriptor } from './grader-factories';
import { DEFAULT_CONFIG } from './defaults';

/** Raw (unvalidated) input shape for validateConfig. */
interface RawEvalConfig {
    version?: string;
    skillPath?: string;
    defaults?: Record<string, unknown> & {
        provider?: unknown;
        docker?: unknown;
        agent?: string;
        trials?: number;
        timeout?: number;
        threshold?: number;
        grader_model?: string;
        environment?: Partial<EnvironmentConfig>;
    };
    tasks?: RawTask[];
}

interface RawTask {
    name?: string;
    type?: string;
    instruction?: string;
    conversation?: RawConversation;
    workspace?: (string | { src?: string; dest?: string; dir?: string; chmod?: string })[];
    graders?: any[];
    solution?: string;
    agent?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
    provider?: unknown;
    docker?: unknown;
}

interface RawConversation {
    opener?: string;
    completion?: {
        max_turns?: number;
        signal?: string;
        done_phrase?: string;
        done_when?: string;
        timeout?: number;
    };
    replies?: RawReply[];
    persona?: { description?: string; facts?: string[]; model?: string };
    step_graders?: RawStepGrader[];
}

interface RawReply {
    content?: string;
    when?: string;
}

interface RawStepGrader {
    after_turn?: number;
    graders?: any[];
}

/**
 * Load eval config from a directory.
 * Discovers *.eval.ts files, falling back to eval.ts for backward compat.
 */
export async function loadEvalConfig(dir: string): Promise<EvalConfig> {
    const files = await fs.readdir(dir);
    const evalFiles = files.filter(f => f.endsWith('.eval.ts'));

    if (evalFiles.length > 1) {
        throw new Error(`Multiple *.eval.ts files found in ${dir}: ${evalFiles.join(', ')}. Only one is allowed.`);
    }

    if (evalFiles.length === 1) {
        return loadEvalConfigFromTs(path.join(dir, evalFiles[0]));
    }

    // Backward compat: fall back to eval.ts
    const legacyPath = path.join(dir, 'eval.ts');
    if (await fs.pathExists(legacyPath)) {
        return loadEvalConfigFromTs(legacyPath);
    }

    throw new Error(`No *.eval.ts found in ${dir}`);
}

/**
 * Load eval config from a TypeScript file using jiti.
 */
async function loadEvalConfigFromTs(filePath: string): Promise<EvalConfig> {
    let mod: { default?: unknown; [key: string]: unknown };
    try {
        const { createJiti } = require('jiti');
        const jiti = createJiti(__filename);
        mod = await jiti.import(path.resolve(filePath));
    } catch (e: unknown) {
        throw new Error(`Failed to load eval config: ${(e as Error).message}. Ensure jiti is installed: npm install jiti`);
    }

    const config = mod.default || mod;

    if (!config || typeof config !== 'object') {
        throw new Error('Eval config must export an EvalConfig (default export or module.exports)');
    }

    return validateConfig(config);
}

/**
 * Validates a raw config object into a typed EvalConfig.
 */
export function validateConfig(raw: unknown): EvalConfig {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Config must be an object');
    }
    const config = raw as RawEvalConfig;

    if (config.defaults?.provider !== undefined) {
        throw new Error('Config no longer supports defaults.provider; pathgrade runs locally only');
    }
    if (config.defaults?.docker !== undefined) {
        throw new Error('Config no longer supports defaults.docker; pathgrade runs locally only');
    }

    const version = config.version || '1';
    const mergedDefaults = {
        ...DEFAULT_CONFIG,
        ...(config.defaults || {}),
        environment: {
            ...DEFAULT_CONFIG.environment,
            ...(config.defaults?.environment || {}),
        },
    };

    if (mergedDefaults.agent && !(VALID_AGENTS as readonly string[]).includes(mergedDefaults.agent)) {
        throw new Error(`Invalid agent "${mergedDefaults.agent}". Must be one of: ${VALID_AGENTS.join(', ')}`);
    }
    const defaults = mergedDefaults as EvalDefaults;

    if (!config.tasks || !Array.isArray(config.tasks) || config.tasks.length === 0) {
        throw new Error('Config must have at least one task in the "tasks" array');
    }

    const tasks: EvalTaskConfig[] = config.tasks.map((t: RawTask, i: number) => {
        if (!t.name) throw new Error(`Task ${i} is missing a "name"`);
        if (!t.type || (t.type !== 'instruction' && t.type !== 'conversation')) {
            throw new Error(`Task "${t.name || i}" is missing a "type" field. Must be 'instruction' or 'conversation'. Got: ${JSON.stringify(t.type)}`);
        }
        if (t.type === 'instruction' && !t.instruction) {
            throw new Error(`Task "${t.name}" has type "instruction" but is missing an "instruction" field`);
        }
        if (t.type === 'conversation' && !t.conversation) {
            throw new Error(`Task "${t.name}" has type "conversation" but is missing a "conversation" block`);
        }
        if (t.agent && !(VALID_AGENTS as readonly string[]).includes(t.agent)) {
            throw new Error(`Invalid agent "${t.agent}" in task "${t.name}". Must be one of: ${VALID_AGENTS.join(', ')}`);
        }
        if (!t.graders || !Array.isArray(t.graders) || t.graders.length === 0) {
            throw new Error(`Task "${t.name}" must have at least one grader`);
        }
        if (t.provider !== undefined || t.docker !== undefined) {
            throw new Error(`Task "${t.name}" uses deprecated provider/docker fields; pathgrade runs locally only`);
        }
        if (t.conversation) {
            if (!t.conversation.opener) {
                throw new Error(`Task "${t.name}" conversation is missing an "opener"`);
            }
            if (!t.conversation.completion || typeof t.conversation.completion !== 'object') {
                throw new Error(`Task "${t.name}" conversation is missing a "completion" block`);
            }
            if (typeof t.conversation.completion.max_turns !== 'number' || t.conversation.completion.max_turns < 1) {
                throw new Error(`Task "${t.name}" conversation completion must include a positive "max_turns"`);
            }
            if (t.conversation.step_graders !== undefined) {
                if (!Array.isArray(t.conversation.step_graders)) {
                    throw new Error(`Task "${t.name}" conversation.step_graders must be an array`);
                }
                for (let sgIdx = 0; sgIdx < t.conversation.step_graders.length; sgIdx++) {
                    const sg = t.conversation.step_graders[sgIdx];
                    if (typeof sg.after_turn !== 'number' || sg.after_turn < 1) {
                        throw new Error(`Task "${t.name}" step_graders[${sgIdx}].after_turn must be a positive number`);
                    }
                    if (!Array.isArray(sg.graders) || sg.graders.length === 0) {
                        throw new Error(`Task "${t.name}" step_graders[${sgIdx}] must have at least one grader`);
                    }
                }
            }
            if (!Array.isArray(t.conversation.replies) && t.conversation.replies !== undefined) {
                throw new Error(`Task "${t.name}" conversation.replies must be an array when provided`);
            }
            if (!t.conversation.persona && (!Array.isArray(t.conversation.replies) || t.conversation.replies.length === 0)) {
                throw new Error(`Task "${t.name}" conversation must include at least one of "replies" or "persona"`);
            }
            if (t.conversation.persona !== undefined) {
                if (!t.conversation.persona.description || typeof t.conversation.persona.description !== 'string') {
                    throw new Error(`Task "${t.name}" conversation.persona must include a string "description"`);
                }
                if (!Array.isArray(t.conversation.persona.facts) || t.conversation.persona.facts.length === 0) {
                    throw new Error(`Task "${t.name}" conversation.persona must include a non-empty "facts" array`);
                }
            }
        }

        const workspace: WorkspaceEntry[] = (t.workspace || []).map((w) => {
            if (typeof w === 'string') {
                // Support shorthand: "fixtures/app.js" → same filename in workspace
                return { src: w, dest: path.basename(w) };
            }
            if ('dir' in w && w.dir) {
                // Directory mapping: mirror entire directory
                return { dir: w.dir, ...(w.chmod ? { chmod: w.chmod } : {}) };
            }
            if (!w.src || !w.dest) {
                throw new Error(`Task "${t.name}" has a workspace mapping without src/dest or dir`);
            }
            return { src: w.src, dest: w.dest, chmod: w.chmod };
        });

        const base = {
            name: t.name,
            workspace,
            graders: (t.graders || []).map((g: any, gIdx: number) => {
                if (!g || typeof g !== 'object') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] must be an object`);
                }
                if (!g.type || typeof g.type !== 'string') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] must have a "type" field`);
                }
                if (g.type === 'deterministic' && typeof g.execute !== 'function') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (deterministic) must have an "execute" function`);
                }
                if (g.type === 'llm_rubric' && typeof g.rubric !== 'string') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (llm_rubric) must have a "rubric" string`);
                }
                if (g.type === 'tool_usage' && !Array.isArray(g.expectations)) {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (tool_usage) must have an "expectations" array`);
                }
                // Pass descriptor through untouched — do NOT reconstruct field-by-field
                // (reconstructing would strip the execute function)
                return g as GraderDescriptor;
            }),
            solution: t.solution,
            agent: t.agent,
            trials: t.trials,
            timeout: t.timeout,
            grader_model: t.grader_model,
            environment: t.environment,
        };

        if (t.type === 'conversation') {
            return {
                ...base,
                type: 'conversation' as const,
                conversation: {
                    opener: t.conversation!.opener,
                    completion: { ...t.conversation!.completion },
                    replies: t.conversation!.replies?.map((reply: RawReply) => {
                        if (!reply?.content) {
                            throw new Error(`Task "${t.name}" conversation replies must include "content"`);
                        }
                        return {
                            content: reply.content,
                            when: reply.when,
                        };
                    }),
                    persona: t.conversation!.persona ? {
                        description: t.conversation!.persona.description,
                        facts: t.conversation!.persona.facts,
                        model: t.conversation!.persona.model,
                    } : undefined,
                    step_graders: t.conversation!.step_graders?.map((sg: RawStepGrader, sgIdx: number) => ({
                        after_turn: sg.after_turn,
                        graders: (sg.graders || []).map((g: any, gIdx: number) => {
                            if (!g || typeof g !== 'object') {
                                throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] must be an object`);
                            }
                            if (g.type === 'deterministic' && typeof g.execute !== 'function') {
                                throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (deterministic) must have an "execute" function`);
                            }
                            if (g.type === 'llm_rubric' && typeof g.rubric !== 'string') {
                                throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (llm_rubric) must have a "rubric" string`);
                            }
                            if (g.type === 'tool_usage' && !Array.isArray(g.expectations)) {
                                throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (tool_usage) must have an "expectations" array`);
                            }
                            return g as GraderDescriptor;
                        }),
                    })),
                },
            } as EvalTaskConfig;
        }
        return {
            ...base,
            type: 'instruction' as const,
            instruction: t.instruction,
        } as EvalTaskConfig;
    });

    return { version, skillPath: config.skillPath, defaults, tasks };
}

async function resolveGrader(g: GraderDescriptor, baseDir: string): Promise<GraderDescriptor> {
    if (g.type === 'llm_rubric' && g.rubric) {
        return { ...g, rubric: await resolveFileOrInline(g.rubric, baseDir) };
    }
    // Deterministic and tool_usage descriptors pass through as-is
    return { ...g };
}

/**
 * Resolve a single task: apply defaults, resolve file references to content.
 */
export async function resolveTask(
    task: EvalTaskConfig,
    defaults: EvalDefaults,
    baseDir: string
): Promise<ResolvedTask> {
    // Merge defaults with task overrides
    const agent = task.agent || defaults.agent;
    const trials = task.trials ?? defaults.trials;
    const timeout = task.timeout ?? defaults.timeout;
    const environment: EnvironmentConfig = {
        ...defaults.environment,
        ...(task.environment || {}),
    };
    const grader_model = task.grader_model || defaults.grader_model;

    // Resolve instruction or conversation based on task type
    const instruction = task.type === 'instruction'
        ? await resolveFileOrInline(task.instruction, baseDir)
        : undefined;
    const conversation = task.type === 'conversation'
        ? await resolveConversation(task.conversation, baseDir)
        : undefined;

    // Resolve graders
    const graders: GraderDescriptor[] = await Promise.all(
        task.graders.map(g => resolveGrader(g, baseDir))
    );

    // Resolve solution path
    const solution = task.solution
        ? path.resolve(baseDir, task.solution)
        : undefined;

    if (task.type === 'conversation') {
        return {
            type: 'conversation' as const,
            name: task.name,
            conversation: conversation!,
            workspace: (task.workspace || []) as WorkspaceMapping[],
            graders,
            solution,
            agent,
            trials,
            timeout,
            grader_model,
            environment,
        };
    }
    return {
        type: 'instruction' as const,
        name: task.name,
        instruction: instruction!,
        workspace: (task.workspace || []) as WorkspaceMapping[],
        graders,
        solution,
        agent,
        trials,
        timeout,
        grader_model,
        environment,
    };
}

async function resolveConversation(
    conversation: ConversationConfig,
    baseDir: string
): Promise<ResolvedConversation> {
    return {
        opener: await resolveFileOrInline(conversation.opener, baseDir),
        completion: conversation.completion,
        replies: conversation.replies
            ? await Promise.all(
                conversation.replies.map(async (reply) => ({
                    content: await resolveFileOrInline(reply.content, baseDir),
                    when: reply.when,
                }))
            )
            : undefined,
        persona: conversation.persona
            ? {
                description: await resolveFileOrInline(conversation.persona.description, baseDir),
                facts: conversation.persona.facts,
                model: conversation.persona.model,
            }
            : undefined,
        step_graders: conversation.step_graders
            ? await Promise.all(
                conversation.step_graders.map(async (sg): Promise<ResolvedStepGrader> => ({
                    after_turn: sg.after_turn,
                    graders: await Promise.all(
                        sg.graders.map(g => resolveGrader(g, baseDir))
                    ),
                }))
            )
            : undefined,
    };
}

/**
 * If value looks like a file path and the file exists, read it.
 * Otherwise return the value as-is (inline content).
 */
async function resolveFileOrInline(value: string, baseDir: string): Promise<string> {
    const trimmed = value.trim();

    // Multi-line strings are always inline content
    if (trimmed.includes('\n')) return trimmed;

    // Check if it could be a file path
    const candidate = path.resolve(baseDir, trimmed);

    // Reject paths that escape the base directory
    const resolvedBase = path.resolve(baseDir);
    if (!candidate.startsWith(resolvedBase + path.sep) && candidate !== resolvedBase) {
        return trimmed;
    }

    if (await fs.pathExists(candidate)) {
        return (await fs.readFile(candidate, 'utf-8')).trim();
    }

    return trimmed;
}
