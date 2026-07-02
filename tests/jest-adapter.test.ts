import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { getCurrentCaseContext } from '../src/sdk/case-context.js';
import { defaultPathgradeConfig } from '../src/config/pathgrade.js';
import { validateNormalizedRunSnapshot } from '../src/runners/model-validation.js';
import { projectNormalizedRunSnapshotToReportInput } from '../src/runners/report-projection.js';
import { createJestInvocationAdapter } from '@wix/pathgrade/adapters/jest';
import { getJestLifecycleMetadata, installJestLifecycle } from '../src/adapters/jest/lifecycle.js';
import { normalizeJestRunResults } from '../src/adapters/jest/results.js';
import type { AdapterLifecycleHooks, AdapterRunHandle } from '../src/runners/adapter.js';

const run: AdapterRunHandle = {
    adapterName: 'jest',
    status: 'completed',
    exitCode: 0,
};
describe('Jest adapter', () => {
    it('normalizes native Jest results into a valid final run snapshot', () => {
        const snapshot = normalizeJestRunResults({
            run,
            results: {
                testResults: [
                    {
                        testFilePath: '/repo/evals/math.eval.ts',
                        assertionResults: [
                            {
                                ancestorTitles: ['math skill'],
                                title: 'adds numbers',
                                fullName: 'math skill adds numbers',
                                status: 'passed',
                                duration: 12,
                            },
                            {
                                ancestorTitles: ['math skill'],
                                title: 'rejects bad output',
                                fullName: 'math skill rejects bad output',
                                status: 'failed',
                                duration: 7,
                                failureMessages: ['Expected true, received false'],
                            },
                            {
                                ancestorTitles: ['math skill'],
                                title: 'skipped case',
                                fullName: 'math skill skipped case',
                                status: 'skipped',
                            },
                            {
                                ancestorTitles: [],
                                title: 'todo case',
                                fullName: 'todo case',
                                status: 'pending',
                            },
                            {
                                ancestorTitles: ['duplicates'],
                                title: 'same name',
                                fullName: 'duplicates same name',
                                status: 'passed',
                            },
                            {
                                ancestorTitles: ['duplicates'],
                                title: 'same name',
                                fullName: 'duplicates same name',
                                status: 'passed',
                            },
                        ],
                    },
                    {
                        testFilePath: '/repo/other/math.eval.ts',
                        assertionResults: [
                            {
                                ancestorTitles: ['math skill'],
                                title: 'adds numbers',
                                fullName: 'math skill adds numbers',
                                status: 'passed',
                                duration: 3,
                            },
                        ],
                    },
                ],
            },
            metadataByCaseId: new Map([
                ['jest:/repo/evals/math.eval.ts:math-skill-adds-numbers:1', [{ score: 0.75, scorers: [] }]],
            ]),
        });

        expect(validateNormalizedRunSnapshot(snapshot, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });
        expect(snapshot.model.units).toEqual([
            expect.objectContaining({ displayName: '/repo/evals/math.eval.ts' }),
            expect.objectContaining({ displayName: '/repo/other/math.eval.ts' }),
        ]);
        expect(snapshot.model.cases).toEqual([
            expect.objectContaining({
                id: 'jest:/repo/evals/math.eval.ts:math-skill-adds-numbers:1',
                name: 'math skill > adds numbers',
                state: 'passed',
                scoringPolicy: { kind: 'from-evaluations' },
                attempts: [expect.objectContaining({
                    durationMs: 12,
                    evaluations: [expect.objectContaining({ score: 0.75 })],
                })],
            }),
            expect.objectContaining({
                name: 'math skill > rejects bad output',
                state: 'failed',
                scoringPolicy: { kind: 'score', score: 0 },
                attempts: [expect.objectContaining({
                    outcome: { kind: 'failed', reason: 'Expected true, received false' },
                    assertions: [expect.objectContaining({
                        name: 'Jest assertion failure',
                        status: 'failed',
                        message: 'Expected true, received false',
                    })],
                })],
            }),
            expect.objectContaining({
                state: 'skipped',
                scoringPolicy: { kind: 'non-scoring', reason: 'skipped' },
            }),
            expect.objectContaining({
                state: 'pending',
                scoringPolicy: { kind: 'non-scoring', reason: 'pending' },
            }),
            expect.objectContaining({
                id: 'jest:/repo/evals/math.eval.ts:duplicates-same-name:1',
            }),
            expect.objectContaining({
                id: 'jest:/repo/evals/math.eval.ts:duplicates-same-name:2',
            }),
            expect.objectContaining({
                id: 'jest:/repo/other/math.eval.ts:math-skill-adds-numbers:1',
            }),
        ]);

        expect(projectNormalizedRunSnapshotToReportInput(snapshot).groups).toEqual([
            expect.objectContaining({
                groupName: '/repo/evals/math.eval.ts',
                cases: expect.arrayContaining([
                    expect.objectContaining({ name: 'math skill > adds numbers', evaluations: [{ score: 0.75 }] }),
                    expect.objectContaining({ name: 'math skill > rejects bad output', evaluations: [{ score: 0 }] }),
                    expect.objectContaining({ name: 'math skill > skipped case', reportable: false }),
                    expect.objectContaining({ name: 'todo case', reportable: false }),
                ]),
            }),
            expect.objectContaining({
                groupName: '/repo/other/math.eval.ts',
            }),
        ]);
    });

    it('attributes flushed Pathgrade metadata through fake Jest hooks', async () => {
        const beforeEachHooks: Array<() => void | Promise<void>> = [];
        const afterEachHooks: Array<() => void | Promise<void>> = [];
        const afterAllHooks: Array<() => void | Promise<void>> = [];
        const flushedCases: string[] = [];
        let unsubscribed = false;
        let state = {
            testPath: '/repo/evals/duplicates.eval.ts',
            currentTestName: 'duplicates same name',
        };
        const lifecycle: AdapterLifecycleHooks = {
            onResult: () => undefined,
            withCaseContext: (context, fn) => {
                expect(context.scope).toBe('runner-case');
                return fn();
            },
            flushCase: async caseId => {
                flushedCases.push(caseId);
                return [{ score: caseId.endsWith(':1') ? 1 : 0.5, scorers: [] }];
            },
            cleanupRun: async () => undefined,
        };

        const handle = installJestLifecycle({
            beforeEach: hook => beforeEachHooks.push(hook),
            afterEach: hook => afterEachHooks.push(hook),
            afterAll: hook => afterAllHooks.push(hook),
            getState: () => state,
            lifecycle,
            subscribeToResults: () => ({ unsubscribe: () => { unsubscribed = true; } }),
        });

        expect(beforeEachHooks).toHaveLength(1);
        expect(afterEachHooks).toHaveLength(1);
        expect(afterAllHooks).toHaveLength(1);

        await beforeEachHooks[0]();
        expect(getCurrentCaseContext()).toEqual({
            status: 'active',
            context: {
                caseId: 'jest:/repo/evals/duplicates.eval.ts:duplicates-same-name:1',
                caseName: 'duplicates same name',
                filePath: '/repo/evals/duplicates.eval.ts',
                scope: 'runner-case',
            },
        });
        await afterEachHooks[0]();

        state = {
            testPath: '/repo/evals/duplicates.eval.ts',
            currentTestName: 'duplicates same name',
        };
        await beforeEachHooks[0]();
        await afterEachHooks[0]();
        await afterAllHooks[0]();

        expect(flushedCases).toEqual([
            'jest:/repo/evals/duplicates.eval.ts:duplicates-same-name:1',
            'jest:/repo/evals/duplicates.eval.ts:duplicates-same-name:2',
        ]);
        expect(getJestLifecycleMetadata()).toEqual(new Map([
            ['jest:/repo/evals/duplicates.eval.ts:duplicates-same-name:1', [{ score: 1, scorers: [] }]],
            ['jest:/repo/evals/duplicates.eval.ts:duplicates-same-name:2', [{ score: 0.5, scorers: [] }]],
        ]));
        expect(unsubscribed).toBe(true);

        handle.restore();
    });

    it('spawns Jest with selected eval files Pathgrade setup reporter and forwarded args', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-jest-invocation-'));
        await fs.outputFile(path.join(cwd, 'alpha.eval.ts'), 'export const __pathgradeMeta = {};\ntest("alpha", () => undefined);\n');
        const calls: Array<{ cwd: string; argv: string[]; env: NodeJS.ProcessEnv }> = [];
        const adapter = createJestInvocationAdapter({
            config: {
                ...defaultPathgradeConfig(),
                runner: { adapter: 'jest', args: [] },
                evals: { include: ['**/*.eval.ts'], exclude: [] },
            },
            spawnJest: request => {
                calls.push(request);
                return 0;
            },
        });

        const exitCode = await adapter.run({
            cwd,
            runnerArgs: ['--testNamePattern=alpha'],
            env: process.env,
        });

        expect(exitCode).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            cwd,
            argv: [
                'alpha.eval.ts',
                '--setupFilesAfterEnv',
                expect.stringContaining('/src/adapters/jest/setup.js'),
                '--reporters',
                'default',
                '--reporters',
                expect.stringContaining('/src/adapters/jest/reporter.cjs'),
                '--testNamePattern=alpha',
            ],
        });
    });

    it('writes a successful empty report when no Jest eval files are discovered', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-jest-empty-'));
        const adapter = createJestInvocationAdapter({
            config: {
                ...defaultPathgradeConfig(),
                runner: { adapter: 'jest', args: [] },
                evals: { include: ['**/*.eval.ts'], exclude: [] },
                reporter: 'json',
            },
            spawnJest: () => {
                throw new Error('Jest should not spawn for an empty Pathgrade selection');
            },
        });

        const exitCode = await adapter.run({
            cwd,
            runnerArgs: [],
            env: process.env,
        });

        expect(exitCode).toBe(0);
        await expect(fs.readJson(path.join(cwd, '.pathgrade', 'results.json'))).resolves.toMatchObject({
            version: 1,
            status: 'pass',
            overall_pass_rate: 0,
            groups: [],
        });
    });

    it('fails clearly when a project has Jest evals but no local Jest install', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-jest-missing-'));
        await fs.outputJson(path.join(cwd, 'package.json'), { type: 'module' });
        await fs.outputFile(path.join(cwd, 'alpha.eval.ts'), 'export const __pathgradeMeta = {};\ntest("alpha", () => undefined);\n');
        const adapter = createJestInvocationAdapter({
            config: {
                ...defaultPathgradeConfig(),
                runner: { adapter: 'jest', args: [] },
                evals: { include: ['**/*.eval.ts'], exclude: [] },
            },
        });

        await expect(adapter.run({
            cwd,
            runnerArgs: [],
            env: process.env,
        })).rejects.toThrow('Jest adapter requires Jest to be installed in the project');
    });

});
