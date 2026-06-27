import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { createVitestAdapter, collectVitestReportGroups } from '../src/runners/vitest-adapter.js';

function makeCase(overrides: {
    id?: string;
    name: string;
    parent?: { type: string; fullName?: string };
    module?: { relativeModuleId: string };
    state: string;
    duration?: number;
    pathgrade?: unknown[];
}) {
    return {
        id: overrides.id ?? overrides.name,
        name: overrides.name,
        parent: overrides.parent ?? { type: 'collector' },
        module: overrides.module ?? { relativeModuleId: 'top.eval.ts' },
        meta: () => ({ pathgrade: overrides.pathgrade }),
        diagnostic: () => ({ duration: overrides.duration }),
        result: () => ({ state: overrides.state }),
    };
}

describe('Vitest runner adapter', () => {
    it('discovers Pathgrade eval units and translates opaque Vitest run handles into normalized report groups', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-vitest-adapter-'));
        await fs.outputFile(
            path.join(cwd, 'alpha.eval.ts'),
            "import { createAgent } from '@wix/pathgrade';\nvoid createAgent;\n",
        );
        await fs.outputFile(path.join(cwd, 'ignored.eval.ts'), 'export const nope = true;\n');

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
        const adapter = createVitestAdapter({
            testModules: [{
                children: {
                    allTests: () => [
                        makeCase({
                            id: 'task-1',
                            name: 'suite case',
                            parent: { type: 'suite', fullName: 'nested suite' },
                            module: { relativeModuleId: 'suite.eval.ts' },
                            state: 'failed',
                            duration: 123,
                            pathgrade: [{ score: 0.2, trial, diagnostics }],
                        }),
                        makeCase({
                            id: 'task-2',
                            name: 'timed out before evaluate',
                            module: { relativeModuleId: 'top.eval.ts' },
                            state: 'timedout',
                            duration: undefined,
                        }),
                    ],
                },
            }] as never,
        });
        const discovered = await adapter.discover({
            cwd,
            include: ['**/*.eval.ts'],
            exclude: ['ignored.eval.ts'],
        });

        expect(discovered.units).toEqual([{
            id: 'alpha.eval.ts',
            displayName: 'alpha.eval.ts',
            sourceRef: 'alpha.eval.ts',
            native: { file: 'alpha.eval.ts' },
        }]);

        const run = await adapter.invoke({
            discovered,
            argv: ['run'],
            env: {},
            lifecycle: {
                onResult: () => undefined,
                withCaseContext: (_context, runCase) => runCase(),
                flushCase: async () => [],
                cleanupRun: async () => undefined,
            },
        });

        const groups = await adapter.collectReportGroups(run);

        expect(run).toMatchObject({
            adapterName: 'vitest',
            status: 'completed',
            exitCode: 0,
        });
        expect(groups).toEqual([
            {
                groupName: 'suite.eval.ts > nested suite',
                cases: [
                    {
                        caseId: 'task-1',
                        name: 'suite case',
                        state: 'failed',
                        runnerDurationMs: 123,
                        sourceRef: 'suite.eval.ts',
                        filePath: 'suite.eval.ts',
                        groupName: 'suite.eval.ts > nested suite',
                        runnerCaseId: 'task-1',
                        evaluations: [{ score: 0.2, trial, diagnostics }],
                        diagnostics: undefined,
                    },
                ],
            },
            {
                groupName: 'top.eval.ts',
                cases: [
                    {
                        caseId: 'task-2',
                        name: 'timed out before evaluate',
                        state: 'failed',
                        runnerDurationMs: 0,
                        sourceRef: 'top.eval.ts',
                        filePath: 'top.eval.ts',
                        groupName: 'top.eval.ts',
                        runnerCaseId: 'task-2',
                        evaluations: undefined,
                        diagnostics: expect.objectContaining({
                            completionReason: 'timedout',
                            score: 0,
                        }),
                    },
                ],
            },
        ]);
    });

    it('keeps the translation helper available behind the Vitest adapter module', () => {
        expect(collectVitestReportGroups([{
            children: {
                allTests: () => [makeCase({ name: 'plain', state: 'passed' })],
            },
        }] as never)).toEqual([{
            groupName: 'top.eval.ts',
            cases: [expect.objectContaining({
                name: 'plain',
                state: 'passed',
            })],
        }]);
    });
});
