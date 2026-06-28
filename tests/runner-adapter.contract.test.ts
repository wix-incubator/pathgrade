import { describe, expect, it } from 'vitest';
import { buildPathgradeReport } from '../src/reporting/core.js';
import { runnerAdapterContractVersion } from '../src/runners/adapter.js';
import { buildNormalizedRunSnapshotFromReportGroups } from '../src/runners/model-builders.js';
import { validateNormalizedRunSnapshot } from '../src/runners/model-validation.js';
import { projectNormalizedRunSnapshotToReportInput } from '../src/runners/report-projection.js';
import type {
    AdapterDiscoveryResult,
    AdapterLifecycleHooks,
    AdapterRunHandle,
    RunnerAdapter,
} from '../src/runners/adapter.js';
import type { NormalizedRunSnapshot } from '../src/runners/model.js';

function makeLifecycle(): AdapterLifecycleHooks {
    const activeCases: string[] = [];

    return {
        onResult: () => undefined,
        withCaseContext: (context, run) => {
            activeCases.push(context.caseId);
            return run();
        },
        flushCase: async caseId => [{
            score: caseId === 'local:case-1' ? 1 : 0,
        }],
        cleanupRun: async () => undefined,
    };
}

describe('runner adapter contract', () => {
    it('validates and projects one completed normalized local run into existing report output', () => {
        const snapshot: NormalizedRunSnapshot = {
            version: 1,
            completeness: 'final',
            model: {
                run: {
                    id: 'run-1',
                    adapterName: 'fake-local',
                    status: 'completed',
                },
                units: [{
                    id: 'unit-1',
                    runId: 'run-1',
                    displayName: 'math.eval.ts',
                }],
                cases: [{
                    id: 'case-1',
                    runId: 'run-1',
                    unitId: 'unit-1',
                    name: 'adds numbers',
                    state: 'passed',
                    scoringPolicy: { kind: 'from-evaluations' },
                    attempts: [{
                        id: 'attempt-1',
                        caseId: 'case-1',
                        outcome: { kind: 'passed' },
                        durationMs: 25,
                        evaluations: [{
                            id: 'evaluation-1',
                            attemptId: 'attempt-1',
                            score: 1,
                        }],
                    }],
                }],
            },
        };

        expect(validateNormalizedRunSnapshot(snapshot, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });

        const reportInput = projectNormalizedRunSnapshotToReportInput(snapshot);

        expect(reportInput).toEqual({
            groups: [{
                groupName: 'math.eval.ts',
                cases: [{
                    caseId: 'case-1',
                    name: 'adds numbers',
                    state: 'passed',
                    runnerDurationMs: 25,
                    evaluations: [{ score: 1 }],
                }],
            }],
        });

        const built = buildPathgradeReport(reportInput);

        expect(built.report).toMatchObject({
            version: 1,
            overall_pass_rate: 1,
            status: 'pass',
            groups: [{
                task: 'math.eval.ts',
                pass_rate: 1,
                pass_at_k: 1,
                pass_pow_k: 1,
                trace_file: 'traces/math-eval-ts.json',
            }],
        });
        expect(built.report.groups[0].trials).toEqual([expect.objectContaining({
            trial_id: 1,
            name: 'adds numbers',
            reward: 1,
            duration_ms: 25,
        })]);

        const malformed: NormalizedRunSnapshot = {
            version: 1,
            completeness: 'final',
            model: {
                run: {
                    id: '',
                    adapterName: '',
                    status: 'completed',
                },
                units: [],
                cases: [],
            },
        };

        expect(validateNormalizedRunSnapshot(malformed, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ path: 'model.run.id' }),
                expect.objectContaining({ path: 'model.run.adapterName' }),
            ]),
        });
    });

    it('supports local events, remote jobs, durable streams, and node:test-style runners without Vitest concepts', async () => {
        expect(runnerAdapterContractVersion).toBe(1);

        const localAdapter: RunnerAdapter = {
            name: 'fake-local',
            async discover(input) {
                return {
                    units: [{
                        id: 'local-file',
                        displayName: 'local file',
                        sourceRef: input.include?.[0],
                        native: { eventName: 'test:start' },
                    }],
                };
            },
            async invoke(input) {
                await input.lifecycle.withCaseContext({
                    caseId: 'local:case-1',
                    caseName: 'local case',
                    sourceRef: 'local.eval.ts',
                    runnerNativeId: 'event-1',
                    scope: 'runner-case',
                }, async () => {
                    input.lifecycle.onResult({
                        result: { score: 1 },
                        agent: {} as never,
                    });
                });
                return {
                    adapterName: this.name,
                    status: 'completed',
                    exitCode: 0,
                    native: { eventCursor: 1 },
                };
            },
            async collectNormalizedRunSnapshot(run) {
                expect(run.native).toEqual({ eventCursor: 1 });
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'local file',
                    cases: [{
                        name: 'local case',
                        state: 'passed',
                        runnerDurationMs: 7,
                        sourceRef: 'local.eval.ts',
                        runnerCaseId: 'event-1',
                        evaluations: [{ score: 1 }],
                    }],
                }]);
            },
        };

        const remoteAdapter: RunnerAdapter = {
            name: 'fake-remote',
            async discover(): Promise<AdapterDiscoveryResult> {
                return {
                    units: [{
                        id: 'dataset:item-1',
                        displayName: 'dataset item',
                        sourceRef: 'langfuse://dataset/items/1',
                        native: { datasetId: 'dataset-1' },
                    }],
                    diagnostics: [{
                        severity: 'info',
                        message: 'remote dataset discovered',
                        sourceRef: 'langfuse://dataset/dataset-1',
                    }],
                };
            },
            async invoke(input): Promise<AdapterRunHandle> {
                expect(input.argv).toEqual(['--remote']);
                expect(input.discovered.units[0].native).toEqual({ datasetId: 'dataset-1' });
                return {
                    adapterName: this.name,
                    status: 'failed',
                    exitCode: 3,
                    native: { jobId: 'job-123', status: 'remote-job-failed' },
                };
            },
            async collectNormalizedRunSnapshot(run) {
                expect(run.status).toBe('failed');
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'remote evaluator',
                    cases: [{
                        name: 'dataset item',
                        state: 'failed',
                        runnerDurationMs: 50,
                        sourceRef: 'langfuse://dataset/items/1',
                        runnerCaseId: 'job-123:item-1',
                        evaluations: [{
                            score: 0,
                            diagnostics: { completionReason: 'remote-job-failed', score: 0 },
                        }],
                    }],
                }]);
            },
        };

        const durableAdapter: RunnerAdapter = {
            name: 'fake-durable',
            async discover() {
                return {
                    units: [{
                        id: 'session:def-1',
                        displayName: 'durable definition',
                        sourceRef: 'eve://definitions/1',
                    }],
                };
            },
            async invoke(input) {
                for (const caseId of ['stream:complete', 'stream:waiting']) {
                    await input.lifecycle.withCaseContext({
                        caseId,
                        caseName: caseId,
                        sourceRef: 'eve://stream',
                        scope: 'runner-case',
                    }, async () => {
                        await input.lifecycle.flushCase(caseId);
                    });
                }
                return {
                    adapterName: this.name,
                    status: 'completed',
                    exitCode: 0,
                    native: { streamOffset: 12 },
                };
            },
            async collectNormalizedRunSnapshot(run) {
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'durable session',
                    cases: [
                        {
                            name: 'complete stream',
                            state: 'passed',
                            runnerDurationMs: 20,
                            evaluations: [{ score: 1 }],
                        },
                        {
                            name: 'waiting stream',
                            state: 'pending',
                            runnerDurationMs: 0,
                            diagnostics: { completionReason: 'parked', score: 0 },
                            evaluations: [{ score: 0 }],
                        },
                    ],
                }]);
            },
        };

        const nodeEventAdapter: RunnerAdapter = {
            name: 'fake-node-test',
            async discover() {
                return { units: [{ id: 'node:test:1', displayName: 'node event case' }] };
            },
            async invoke() {
                return {
                    adapterName: this.name,
                    status: 'completed',
                    exitCode: 0,
                    native: { events: [{ type: 'test:pass', nesting: 0 }] },
                };
            },
            async collectNormalizedRunSnapshot(run) {
                expect(run.native).toEqual({ events: [{ type: 'test:pass', nesting: 0 }] });
                return buildNormalizedRunSnapshotFromReportGroups(run, [{
                    groupName: 'node events',
                    cases: [{
                        name: 'node event case',
                        state: 'skipped',
                        runnerDurationMs: 1,
                    }],
                }]);
            },
        };

        for (const adapter of [localAdapter, remoteAdapter, durableAdapter, nodeEventAdapter]) {
            const discovered = await adapter.discover({
                cwd: process.cwd(),
                include: ['**/*.eval.ts'],
                exclude: ['node_modules/**'],
                selection: {
                    base_ref: 'HEAD',
                    changed_files_count: 0,
                    selected: [],
                    skipped: [],
                },
            });
            const run = await adapter.invoke({
                discovered,
                argv: adapter.name === 'fake-remote' ? ['--remote'] : [],
                env: {},
                lifecycle: makeLifecycle(),
            });
            const snapshot = await adapter.collectNormalizedRunSnapshot(run);
            const reportInput = projectNormalizedRunSnapshotToReportInput(snapshot);

            expect(run.adapterName).toBe(adapter.name);
            expect(['completed', 'failed', 'cancelled']).toContain(run.status);
            expect(reportInput.groups.every(group => group.cases.every(testCase => (
                testCase.state === 'passed'
                || testCase.state === 'failed'
                || testCase.state === 'skipped'
                || testCase.state === 'pending'
            )))).toBe(true);
        }
    });
});
