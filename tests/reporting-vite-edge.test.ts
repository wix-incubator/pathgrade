import { describe, expect, it } from 'vitest';
import { collectVitestReportGroups, collectVitestRunResult } from '../src/reporting/vitest-edge.js';

function makeCase(overrides: {
    name: string;
    parent?: { type: string; fullName?: string };
    module?: { relativeModuleId: string };
    state: 'passed' | 'failed' | 'skipped' | 'pending';
    duration?: number;
    pathgrade?: unknown[];
}) {
    return {
        name: overrides.name,
        parent: overrides.parent ?? { type: 'collector' },
        module: overrides.module ?? { relativeModuleId: 'top.eval.ts' },
        meta: () => ({ pathgrade: overrides.pathgrade }),
        diagnostic: () => ({ duration: overrides.duration }),
        result: () => ({ state: overrides.state }),
    };
}

describe('Vitest reporting edge', () => {
    it('translates Vitest-shaped modules into normalized reporting groups', () => {
        const diagnostics = { completionReason: 'timeout', score: 0.2 };
        const trial = {
            trial_id: 9,
            reward: 0.2,
            scorer_results: [],
            duration_ms: 1,
            n_commands: 1,
            input_tokens: 2,
            output_tokens: 3,
            session_log: [],
        };
        const groups = collectVitestReportGroups([
            {
                children: {
                    allTests: () => [
                        makeCase({
                            name: 'suite case',
                            parent: { type: 'suite', fullName: 'nested suite' },
                            module: { relativeModuleId: 'suite.eval.ts' },
                            state: 'failed',
                            duration: 123,
                            pathgrade: [{ score: 0.2, trial, diagnostics }],
                        }),
                        makeCase({
                            name: 'top level',
                            module: { relativeModuleId: 'top.eval.ts' },
                            state: 'passed',
                            duration: undefined,
                        }),
                    ],
                },
            },
        ] as any);

        expect(groups).toEqual([
            {
                groupName: 'suite.eval.ts > nested suite',
                cases: [
                    {
                        name: 'suite case',
                        state: 'failed',
                        runnerDurationMs: 123,
                        evaluations: [{ score: 0.2, trial, diagnostics }],
                        diagnostics: undefined,
                    },
                ],
            },
            {
                groupName: 'top.eval.ts',
                cases: [
                    {
                        name: 'top level',
                        state: 'passed',
                        runnerDurationMs: 0,
                        evaluations: undefined,
                        diagnostics: undefined,
                    },
                ],
            },
        ]);
    });

    it('collects module, suite, and unhandled run failures', () => {
        const run = collectVitestRunResult([
            {
                relativeModuleId: 'setup.eval.ts',
                errors: () => [{
                    name: 'SyntaxError',
                    message: 'Failed to load setup',
                    stack: 'SyntaxError: Failed to load setup',
                }],
                children: {
                    allSuites: () => [{
                        fullName: 'agent setup > authenticated session',
                        errors: () => [{
                            name: 'Error',
                            message: 'Hook timed out in 900000ms.',
                            stack: 'Error: Hook timed out in 900000ms.',
                        }],
                    }],
                },
            },
        ] as any, [{
            name: 'Error',
            message: 'worker exited unexpectedly',
            stack: 'Error: worker exited unexpectedly',
        }], 'failed');

        expect(run).toEqual({
            reason: 'failed',
            failures: [
                {
                    scope: 'module',
                    file: 'setup.eval.ts',
                    name: 'SyntaxError',
                    message: 'Failed to load setup',
                    stack: 'SyntaxError: Failed to load setup',
                },
                {
                    scope: 'suite',
                    file: 'setup.eval.ts',
                    suite: 'agent setup > authenticated session',
                    name: 'Error',
                    message: 'Hook timed out in 900000ms.',
                    stack: 'Error: Hook timed out in 900000ms.',
                },
                {
                    scope: 'unhandled',
                    name: 'Error',
                    message: 'worker exited unexpectedly',
                    stack: 'Error: worker exited unexpectedly',
                },
            ],
        });
    });
});
