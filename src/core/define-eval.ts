import { EvalConfig, DefineEvalInput } from './config.types';
import { validateConfig } from './config';

/**
 * Define a pathgrade evaluation config in TypeScript.
 * All defaults are optional — same defaults as EvalConfig.
 */
export function defineEval(input: DefineEvalInput): EvalConfig {
    const raw: Record<string, any> = {
        version: input.version || '1',
        skillPath: input.skillPath,
        defaults: input.defaults ? {
            ...input.defaults,
            environment: input.defaults.environment ? {
                ...input.defaults.environment,
            } : undefined,
        } : undefined,
        tasks: input.tasks.map(t => {
            const base = {
                name: t.name,
                workspace: t.workspace,
                graders: t.graders.map(g => ({
                    type: g.type,
                    setup: g.setup,
                    run: g.run,
                    rubric: g.rubric,
                    model: g.model,
                    weight: g.weight,
                })),
                solution: t.solution,
                agent: t.agent,
                trials: t.trials,
                timeout: t.timeout,
                grader_model: t.grader_model,
                environment: t.environment,
            };
            if (t.type === 'conversation') {
                return { ...base, type: 'conversation' as const, conversation: t.conversation };
            }
            return { ...base, type: t.type, instruction: t.instruction };
        }),
    };

    return validateConfig(raw);
}
