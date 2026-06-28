import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import type { RunnerAdapter } from '../src/runners/adapter.js';
import { buildNormalizedRunSnapshotFromReportGroups } from '../src/runners/model-builders.js';
import { runWithAdapter } from '../src/runners/orchestrator.js';

describe('adapter run orchestrator', () => {
    it('discovers, invokes, collects normalized groups, writes Pathgrade artifacts, presents summaries, and cleans up', async () => {
        const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-orchestrator-'));
        const events: string[] = [];
        const summaries: unknown[] = [];
        const warnings: string[] = [];
        let cleanupCalled = false;

        const adapter: RunnerAdapter = {
            name: 'fake-adapter',
            async discover(input) {
                events.push(`discover:${input.cwd}:${input.include?.join(',')}:${input.selection?.base_ref}`);
                return {
                    units: [{
                        id: 'unit-1',
                        displayName: 'unit one',
                        sourceRef: 'dataset://unit-1',
                        native: { privateRunnerObject: true },
                    }],
                };
            },
            async invoke(input) {
                events.push(`invoke:${input.argv.join(',')}:${input.discovered.units.length}`);
                await input.lifecycle.withCaseContext({
                    caseId: 'case-1',
                    caseName: 'case one',
                    sourceRef: 'dataset://unit-1/case-1',
                    scope: 'runner-case',
                }, async () => undefined);
                return {
                    adapterName: this.name,
                    status: 'failed',
                    exitCode: 7,
                    native: { runnerSecret: 'opaque-to-orchestrator' },
                };
            },
            async collectNormalizedRunSnapshot(run) {
                events.push(`collect:${run.adapterName}:${run.status}:${run.exitCode}`);
                expect(run.native).toEqual({ runnerSecret: 'opaque-to-orchestrator' });
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'fake group',
                    cases: [{
                        caseId: 'case-1',
                        name: 'case one',
                        state: 'passed',
                        runnerDurationMs: 12,
                        sourceRef: 'dataset://unit-1/case-1',
                        evaluations: [{ score: 0.75 }],
                    }],
                }]);
            },
        };

        const exitCode = await runWithAdapter({
            adapter,
            options: {
                cwd: process.cwd(),
                discovery: {
                    cwd: process.cwd(),
                    include: ['**/*.eval.ts'],
                    selection: { base_ref: 'HEAD', changed_files_count: 0, selected: [], skipped: [] },
                },
                runnerArgs: ['--fake'],
                env: {},
                threshold: 0.8,
                artifactRoot,
                reporterMode: 'cli',
                lifecycle: {
                    onResult: () => undefined,
                    withCaseContext: (_context, run) => run(),
                    flushCase: async () => [],
                    cleanupRun: async () => {
                        cleanupCalled = true;
                        events.push('cleanup');
                    },
                },
                printSummary: summary => summaries.push(summary),
                warn: warning => warnings.push(warning),
            },
        });

        expect(exitCode).toBe(7);
        expect(cleanupCalled).toBe(true);
        expect(events).toEqual([
            `discover:${process.cwd()}:**/*.eval.ts:HEAD`,
            'invoke:--fake:1',
            'collect:fake-adapter:failed:7',
            'cleanup',
        ]);
        expect(summaries).toHaveLength(1);
        expect(warnings).toEqual([]);

        const report = await fs.readJson(path.join(artifactRoot, 'results.json'));
        expect(report).toMatchObject({
            version: 1,
            threshold: 0.8,
            overall_pass_rate: 0.75,
            status: 'fail',
            selection: { base_ref: 'HEAD' },
            groups: [{
                task: 'fake group',
                pass_rate: 1,
            }],
        });
        expect(await fs.pathExists(path.join(artifactRoot, 'traces', 'fake-group.json'))).toBe(true);
    });

    it('passes top-level selection into adapter discovery and report metadata', async () => {
        const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-orchestrator-selection-'));
        const discoveredSelections: unknown[] = [];
        const adapter: RunnerAdapter = {
            name: 'selection-adapter',
            async discover(input) {
                discoveredSelections.push(input.selection);
                return { units: [{ id: 'unit-1', displayName: 'unit one' }] };
            },
            async invoke() {
                return { adapterName: this.name, status: 'completed', exitCode: 0 };
            },
            async collectNormalizedRunSnapshot(run) {
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'selected group',
                    cases: [{
                        name: 'selected case',
                        state: 'passed',
                        runnerDurationMs: 1,
                        evaluations: [{ score: 1 }],
                    }],
                }]);
            },
        };
        const selection = {
            base_ref: 'origin/main@abc123',
            changed_files_count: 1,
            selected: ['selected.eval.ts'],
            skipped: [],
        };

        await runWithAdapter({
            adapter,
            options: {
                cwd: process.cwd(),
                discovery: { cwd: process.cwd() },
                runnerArgs: [],
                env: {},
                artifactRoot,
                selection,
            },
        });

        expect(discoveredSelections).toEqual([selection]);
        const report = await fs.readJson(path.join(artifactRoot, 'results.json'));
        expect(report.selection).toEqual(selection);
    });

    it('normalizes non-completed adapter status to a nonzero exit code', async () => {
        const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-orchestrator-status-'));
        const adapter: RunnerAdapter = {
            name: 'cancelled-adapter',
            async discover() {
                return { units: [{ id: 'unit-1', displayName: 'unit one' }] };
            },
            async invoke() {
                return { adapterName: this.name, status: 'cancelled', exitCode: 0 };
            },
            async collectNormalizedRunSnapshot(run) {
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'cancelled group',
                    cases: [{
                        name: 'cancelled case',
                        state: 'passed',
                        runnerDurationMs: 1,
                        evaluations: [{ score: 1 }],
                    }],
                }]);
            },
        };

        await expect(runWithAdapter({
            adapter,
            options: {
                cwd: process.cwd(),
                discovery: { cwd: process.cwd() },
                runnerArgs: [],
                env: {},
                artifactRoot,
            },
        })).resolves.toBe(1);
    });

    it('treats timed-out and parked adapter runs as nonzero CI exits while reports stay pass or fail', async () => {
        for (const status of ['timed_out', 'parked'] as const) {
            const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), `pathgrade-orchestrator-${status}-`));
            const adapter: RunnerAdapter = {
                name: `${status}-adapter`,
                async discover() {
                    return { units: [{ id: 'unit-1', displayName: 'unit one' }] };
                },
                async invoke() {
                    return {
                        adapterName: this.name,
                        status,
                        exitCode: 0,
                        ...(status === 'parked' ? { diagnostics: [{ severity: 'warning' as const, message: 'terminal parked run' }] } : {}),
                    };
                },
                async collectNormalizedRunSnapshot(run) {
                    return buildNormalizedRunSnapshotFromReportGroups(run, [{
                        groupName: `${status} group`,
                        cases: [{
                            name: `${status} case`,
                            state: 'passed',
                            runnerDurationMs: 1,
                            evaluations: [{ score: 1 }],
                        }],
                    }]);
                },
            };

            await expect(runWithAdapter({
                adapter,
                options: {
                    cwd: process.cwd(),
                    discovery: { cwd: process.cwd() },
                    runnerArgs: [],
                    env: {},
                    artifactRoot,
                },
            })).resolves.toBe(1);

            const report = await fs.readJson(path.join(artifactRoot, 'results.json'));
            expect(['pass', 'fail']).toContain(report.status);
        }
    });
});
