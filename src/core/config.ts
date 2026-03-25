/**
 * Parser and validator for eval config files (eval.ts or eval.yaml).
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import {
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    ResolvedGrader,
    ConversationConfig,
    ResolvedConversation,
    WorkspaceMapping,
    EnvironmentConfig,
} from './config.types';
import { DEFAULT_CONFIG } from './defaults';

/**
 * Load eval config from a directory.
 * Tries eval.ts first (TypeScript config), then eval.yaml.
 */
export async function loadEvalConfig(dir: string): Promise<EvalConfig> {
    // Try eval.ts first
    const tsPath = path.join(dir, 'eval.ts');
    if (await fs.pathExists(tsPath)) {
        return loadEvalConfigFromTs(tsPath);
    }

    // Fall back to eval.yaml
    const yamlPath = path.join(dir, 'eval.yaml');
    if (!await fs.pathExists(yamlPath)) {
        throw new Error(`No eval.ts or eval.yaml found in ${dir}`);
    }

    let yaml: any;
    try {
        yaml = require('js-yaml');
    } catch {
        throw new Error('js-yaml is required. Run: npm install js-yaml');
    }

    const content = await fs.readFile(yamlPath, 'utf-8');
    const raw = yaml.load(content) as any;

    return validateConfig(raw);
}

/**
 * Load eval config from a TypeScript file using jiti.
 */
async function loadEvalConfigFromTs(filePath: string): Promise<EvalConfig> {
    let mod: any;
    try {
        const { createJiti } = require('jiti');
        const jiti = createJiti(__filename);
        mod = await jiti.import(path.resolve(filePath));
    } catch (e: any) {
        throw new Error(`Failed to load eval.ts: ${e.message}. Ensure jiti is installed: npm install jiti`);
    }

    const config = mod.default || mod;

    if (!config || typeof config !== 'object') {
        throw new Error('eval.ts must export an EvalConfig (default export or module.exports)');
    }

    return validateConfig(config);
}

/**
 * Validate raw config into a typed EvalConfig.
 * Works for both YAML-parsed and TypeScript-defined configs.
 */
export function validateConfig(raw: any): EvalConfig {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Config must be an object');
    }

    if (raw.defaults?.provider !== undefined) {
        throw new Error('Config no longer supports defaults.provider; pathgrade runs locally only');
    }
    if (raw.defaults?.docker !== undefined) {
        throw new Error('Config no longer supports defaults.docker; pathgrade runs locally only');
    }

    const version = raw.version || '1';
    const defaults: EvalDefaults = {
        ...DEFAULT_CONFIG,
        ...(raw.defaults || {}),
        environment: {
            ...DEFAULT_CONFIG.environment,
            ...(raw.defaults?.environment || {}),
        },
    };

    if (!raw.tasks || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
        throw new Error('Config must have at least one task in the "tasks" array');
    }

    const tasks: EvalTaskConfig[] = raw.tasks.map((t: any, i: number) => {
        if (!t.name) throw new Error(`Task ${i} is missing a "name"`);
        if (t.instruction && t.conversation) {
            throw new Error(`Task "${t.name}" must define exactly one of "instruction" or "conversation"`);
        }
        if (!t.instruction && !t.conversation) {
            throw new Error(`Task "${t.name}" is missing an "instruction" or "conversation"`);
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
                throw new Error(`Task "${t.name}" conversation.step_graders are not supported yet`);
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

        const workspace: WorkspaceMapping[] = (t.workspace || []).map((w: any) => {
            if (typeof w === 'string') {
                // Support shorthand: "fixtures/app.js" → same filename in workspace
                return { src: w, dest: path.basename(w) };
            }
            if (!w.src || !w.dest) {
                throw new Error(`Task "${t.name}" has a workspace mapping without src/dest`);
            }
            return { src: w.src, dest: w.dest, chmod: w.chmod };
        });

        return {
            name: t.name,
            instruction: t.instruction,
            conversation: t.conversation ? {
                opener: t.conversation.opener,
                completion: {
                    max_turns: t.conversation.completion.max_turns,
                    signal: t.conversation.completion.signal,
                    done_phrase: t.conversation.completion.done_phrase,
                    timeout: t.conversation.completion.timeout,
                },
                replies: t.conversation.replies?.map((reply: any) => {
                    if (!reply?.content) {
                        throw new Error(`Task "${t.name}" conversation replies must include "content"`);
                    }
                    return {
                        content: reply.content,
                        when: reply.when,
                    };
                }),
                persona: t.conversation.persona ? {
                    description: t.conversation.persona.description,
                    facts: t.conversation.persona.facts,
                    model: t.conversation.persona.model,
                } : undefined,
            } : undefined,
            workspace,
            graders: t.graders.map((g: any) => ({
                type: g.type,
                setup: g.setup,
                run: g.run,
                rubric: g.rubric,
                model: g.model,
                weight: g.weight ?? 1.0,
            })),
            solution: t.solution,
            agent: t.agent,
            trials: t.trials,
            timeout: t.timeout,
            grader_model: t.grader_model,
            environment: t.environment,
        };
    });

    return { version, skill: raw.skill, defaults, tasks };
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

    // Resolve instruction — could be inline text or file path
    const instruction = task.instruction
        ? await resolveFileOrInline(task.instruction, baseDir)
        : undefined;
    const conversation = task.conversation
        ? await resolveConversation(task.conversation, baseDir)
        : undefined;

    // Resolve graders
    const graders: ResolvedGrader[] = await Promise.all(
        task.graders.map(async g => {
            const resolved: ResolvedGrader = {
                type: g.type,
                setup: g.setup,
                model: g.model,
                weight: g.weight,
            };
            if (g.type === 'deterministic' && g.run) {
                resolved.run = await resolveFileOrInline(g.run, baseDir);
            }
            if (g.type === 'llm_rubric' && g.rubric) {
                resolved.rubric = await resolveFileOrInline(g.rubric, baseDir);
            }
            return resolved;
        })
    );

    // Resolve solution path
    const solution = task.solution
        ? path.resolve(baseDir, task.solution)
        : undefined;

    return {
        name: task.name,
        instruction,
        conversation,
        workspace: task.workspace || [],
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

    // Check if it could be a file path (no spaces except in path, has extension)
    const candidate = path.resolve(baseDir, trimmed);
    if (await fs.pathExists(candidate)) {
        return (await fs.readFile(candidate, 'utf-8')).trim();
    }

    return trimmed;
}
