import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPathgradeReport } from '../src/reporting/core.js';
import { validateNormalizedRunSnapshot } from '../src/runners/model-validation.js';
import { projectNormalizedRunSnapshotToReportInput } from '../src/runners/report-projection.js';
import type { ReportGroupInput } from '../src/reporting/types.js';
import type { NormalizedRunSnapshot, RunCaseRecord } from '../src/runners/model.js';

describe('adapter boundary regressions', () => {
    it('keeps the node:test proof adapter implementation under the adapter package', () => {
        const runnerFiles = fs.readdirSync(path.join(process.cwd(), 'src/runners'));

        expect(runnerFiles.filter(file => file.startsWith('node-test')))
            .toEqual([]);
    });

    it('keeps report metrics, trace paths, artifact shape, and threshold status out of adapters', () => {
        const vitestAdapterSource = fs.readFileSync(path.join(process.cwd(), 'src/runners/vitest-adapter.ts'), 'utf8');
        const vitestLifecycleSource = fs.readFileSync(path.join(process.cwd(), 'src/runners/vitest-lifecycle.ts'), 'utf8');

        for (const [name, source] of Object.entries({
            'vitest-adapter.ts': vitestAdapterSource,
            'vitest-lifecycle.ts': vitestLifecycleSource,
        })) {
            expect(source, `${name} must not compute report metrics`).not.toMatch(/\bpass_rate\b|\bpass_at_k\b|\bpass_pow_k\b|\btrace_file\b|\boverall_pass_rate\b/);
            expect(source, `${name} must not write Pathgrade artifacts`).not.toMatch(/writePathgradeArtifacts|results\.json|['"]\.pathgrade['"]/);
        }
    });

    it('accepts adapter-normalized boolean, numeric, assertion-style, and text diagnostic scores while reporting core owns math', () => {
        const groups: ReportGroupInput[] = [{
            groupName: 'future adapters',
            cases: [
                {
                    caseId: 'boolean-score',
                    name: 'boolean score',
                    state: 'passed',
                    runnerDurationMs: 1,
                    sourceRef: 'langfuse://score/boolean',
                    evaluations: [{ score: 1 }],
                },
                {
                    caseId: 'numeric-score',
                    name: 'numeric score',
                    state: 'passed',
                    runnerDurationMs: 1,
                    sourceRef: 'langfuse://score/numeric',
                    evaluations: [{ score: 0.5 }],
                },
                {
                    caseId: 'assertion-score',
                    name: 'assertion score',
                    state: 'failed',
                    runnerDurationMs: 1,
                    sourceRef: 'evalforge://assertions/1',
                    evaluations: [{
                        score: 0.25,
                        diagnostics: {
                            turns: 0,
                            totalDurationMs: 0,
                            completionReason: 'assertion-failed',
                            completionDetail: '3 of 4 assertions failed',
                            score: 0.25,
                            turnDetails: [],
                            reactionsFired: [],
                            runtimePoliciesApplied: [],
                            recommendedTimeoutMs: 30_000,
                            warnings: ['assertion failure'],
                            scorers: [],
                        },
                    }],
                },
                {
                    caseId: 'text-diagnostic',
                    name: 'text diagnostic',
                    state: 'pending',
                    runnerDurationMs: 0,
                    sourceRef: 'eve://session/waiting',
                    diagnostics: {
                        turns: 0,
                        totalDurationMs: 0,
                        completionReason: 'parked',
                        completionDetail: 'waiting for human input',
                        score: 0,
                        turnDetails: [],
                        reactionsFired: [],
                        runtimePoliciesApplied: [],
                        recommendedTimeoutMs: 30_000,
                        warnings: [],
                        scorers: [],
                    },
                    evaluations: [{ score: 0 }],
                },
            ],
        }];

        const built = buildPathgradeReport({ threshold: 0.6, groups });

        expect(built.report).toMatchObject({
            overall_pass_rate: (1 + 0.5 + 0.25) / 3,
            status: 'fail',
            groups: [{
                task: 'future adapters',
                pass_rate: 2 / 3,
                pass_at_k: 1 - Math.pow(1 - 2 / 3, 3),
                pass_pow_k: Math.pow(2 / 3, 3),
                trace_file: 'traces/future-adapters.json',
            }],
        });
        expect(built.report.groups[0].trials).toHaveLength(3);
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('caseId');
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('sourceRef');
        expect(built.summaries[0].diagnostics).toEqual([{
            caseName: 'assertion score',
            state: 'failed',
            report: expect.objectContaining({
                completionReason: 'assertion-failed',
                completionDetail: '3 of 4 assertions failed',
            }),
        }]);
    });

    it('projects report math from scoring policy while preserving last-evaluation and grouping-hint semantics', () => {
        const cases: RunCaseRecord[] = [
            runCase({ id: 'passed-from-evals', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [0.2, 0.8] }),
            runCase({ id: 'failed-score', state: 'failed', scoringPolicy: { kind: 'score', score: 0.4 } }),
            runCase({ id: 'passed-non-scoring', state: 'passed', scoringPolicy: { kind: 'non-scoring', reason: 'informational' } }),
            runCase({ id: 'skipped-score', state: 'skipped', scoringPolicy: { kind: 'score', score: 0.6 } }),
            runCase({ id: 'pending-eval', state: 'pending', scoringPolicy: { kind: 'from-evaluations' }, scores: [0.3] }),
            runCase({ id: 'skipped-non-scoring', state: 'skipped', scoringPolicy: { kind: 'non-scoring', reason: 'skipped' } }),
        ];
        const snapshot = normalizedSnapshot(cases);

        expect(validateNormalizedRunSnapshot(snapshot, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });

        const reportInput = projectNormalizedRunSnapshotToReportInput(snapshot);

        expect(reportInput.groups).toEqual([{
            groupName: 'suite label',
                cases: [
                expect.objectContaining({ caseId: 'passed-from-evals', state: 'passed', evaluations: [{ score: 0.8 }] }),
                expect.objectContaining({ caseId: 'failed-score', state: 'failed', evaluations: [{ score: 0.4 }] }),
                expect.objectContaining({ caseId: 'skipped-score', state: 'skipped', evaluations: [{ score: 0.6 }] }),
                expect.objectContaining({ caseId: 'pending-eval', state: 'pending', evaluations: [{ score: 0.3 }] }),
                expect.objectContaining({ caseId: 'skipped-non-scoring', state: 'skipped', reportable: false }),
            ],
        }]);

        const built = buildPathgradeReport(reportInput);

        expect(built.report.overall_pass_rate).toBe((0.8 + 0.4 + 0.6 + 0.3) / 4);
        expect(built.report.groups[0]).toMatchObject({
            task: 'suite label',
            pass_rate: 1 / 4,
        });

        const malformed = normalizedSnapshot([
            runCase({ id: 'missing-evaluation', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [] }),
            runCase({ id: 'bad-score', state: 'failed', scoringPolicy: { kind: 'score', score: Number.NaN } }),
            runCase({ id: 'empty-reason', state: 'pending', scoringPolicy: { kind: 'non-scoring', reason: ' ' } }),
        ]);

        expect(validateNormalizedRunSnapshot(malformed, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ path: 'model.cases.0.scoringPolicy' }),
                expect.objectContaining({ path: 'model.cases.1.scoringPolicy.score' }),
                expect.objectContaining({ path: 'model.cases.2.scoringPolicy.reason' }),
            ]),
        });
    });

    it('preserves trial compatibility while assertions stay out of report math and artifacts', () => {
        const snapshot = normalizedSnapshot([
            {
                ...runCase({ id: 'multi-eval', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [0.1, 0.9] }),
                attempts: [{
                    id: 'multi-eval-attempt',
                    caseId: 'multi-eval',
                    outcome: { kind: 'passed' },
                    durationMs: 50,
                    evaluations: [
                        { id: 'multi-eval-evaluation-0', attemptId: 'multi-eval-attempt', score: 0.1 },
                        {
                            id: 'multi-eval-evaluation-1',
                            attemptId: 'multi-eval-attempt',
                            score: 0.9,
                            trial: {
                                trial_id: 99,
                                reward: 0.9,
                                scorer_results: [{ scorer_type: 'judge', score: 0.9, weight: 1 }],
                                duration_ms: 45,
                                n_commands: 2,
                                input_tokens: 3,
                                output_tokens: 4,
                                session_log: [],
                            },
                        },
                    ],
                    assertions: [{
                        id: 'assertion-1',
                        attemptId: 'multi-eval-attempt',
                        name: 'contains evidence',
                        status: 'failed',
                        severity: 'error',
                        evidence: 'private assertion evidence',
                    }],
                }],
            },
            {
                ...runCase({ id: 'assertion-only', state: 'failed', scoringPolicy: { kind: 'non-scoring', reason: 'assertion evidence only' }, scores: [] }),
                attempts: [{
                    id: 'assertion-only-attempt',
                    caseId: 'assertion-only',
                    outcome: { kind: 'failed', reason: 'assertion failed' },
                    assertions: [{
                        id: 'assertion-2',
                        attemptId: 'assertion-only-attempt',
                        name: 'preserved but not scored',
                        status: 'failed',
                        evidence: 'kept in normalized model only',
                    }],
                }],
            },
            runCase({ id: 'skipped-final', state: 'skipped', scoringPolicy: { kind: 'non-scoring', reason: 'skipped' }, scores: [] }),
        ]);

        expect(snapshot.model.cases[0].attempts[0].assertions).toEqual([expect.objectContaining({
            evidence: 'private assertion evidence',
        })]);
        expect(validateNormalizedRunSnapshot(snapshot, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });

        const reportInput = projectNormalizedRunSnapshotToReportInput(snapshot);

        expect(reportInput.groups[0].cases).toEqual(expect.arrayContaining([expect.objectContaining({
            caseId: 'multi-eval',
            evaluations: [expect.objectContaining({ score: 0.9, trial: expect.objectContaining({ trial_id: 99 }) })],
        })]));

        const built = buildPathgradeReport(reportInput);

        expect(built.report.overall_pass_rate).toBe(0.9);
        expect(built.report.groups[0].trials[0]).toMatchObject({
            trial_id: 1,
            reward: 0.9,
            scorer_results: [{ scorer_type: 'judge', score: 0.9, weight: 1 }],
            n_commands: 2,
        });
        expect(JSON.stringify(built.report)).not.toContain('assertion');
        expect(JSON.stringify(built.traces)).not.toContain('assertion');

        const malformed = normalizedSnapshot([
            {
                ...runCase({ id: 'bad-skipped', state: 'skipped', scoringPolicy: { kind: 'non-scoring', reason: 'skipped' }, scores: [] }),
                attempts: [{
                    id: 'bad-skipped-attempt',
                    caseId: 'bad-skipped',
                    outcome: { kind: 'passed' },
                }],
            },
        ]);

        expect(validateNormalizedRunSnapshot(malformed, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: [expect.objectContaining({ path: 'model.cases.0.attempts.0.outcome' })],
        });
    });

    it('validates display-safe native references and ignores empty diagnostic-only eval units during projection', () => {
        const snapshot = normalizedSnapshot([
            {
                ...runCase({ id: 'remote-case', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [1] }),
                nativeReferences: [{ kind: 'case', id: 'native-case-1', url: 'https://example.com/cases/1' }],
                diagnostics: [{ severity: 'info', message: 'case diagnostic' }],
                attempts: [{
                    id: 'remote-case-attempt',
                    caseId: 'remote-case',
                    outcome: { kind: 'passed' },
                    diagnostics: [{ severity: 'warning', message: 'attempt diagnostic' }],
                    evaluations: [{
                        id: 'remote-case-evaluation',
                        attemptId: 'remote-case-attempt',
                        score: 1,
                        nativeReferences: [{ kind: 'score', label: 'remote score', url: 'http://example.com/scores/1' }],
                    }],
                    assertions: [{
                        id: 'remote-case-assertion',
                        attemptId: 'remote-case-attempt',
                        name: 'assertion with native ref',
                        status: 'passed',
                        nativeReferences: [{ kind: 'assertion', id: 'assertion-1' }],
                    }],
                }],
            },
        ]);
        snapshot.model.run.diagnostics = [{ severity: 'info', message: 'discovered remotely' }];
        snapshot.model.run.nativeReferences = [{ kind: 'run', id: 'run-native-1', metadata: { shard: 1, retry: false } }];
        snapshot.model.units.push({
            id: 'empty-unit',
            runId: 'run-1',
            displayName: 'empty remote dataset',
            diagnostics: [{ severity: 'warning', message: 'no matching cases' }],
            nativeReferences: [{ kind: 'dataset', url: 'https://example.com/datasets/empty' }],
        });

        expect(validateNormalizedRunSnapshot(snapshot, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });

        const built = buildPathgradeReport(projectNormalizedRunSnapshotToReportInput(snapshot));

        expect(built.report.groups.map(group => group.task)).toEqual(['suite label']);
        expect(JSON.stringify(built.report)).not.toContain('nativeReferences');
        expect(JSON.stringify(built.report)).not.toContain('discovered remotely');
        expect(JSON.stringify(built.traces)).not.toContain('nativeReferences');

        const malformed = normalizedSnapshot([
            {
                ...runCase({ id: 'unsafe-native', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [1] }),
                nativeReferences: [{
                    kind: 'case',
                    url: 'javascript:alert(1)',
                    metadata: { nested: { unsafe: true } as never },
                }],
            },
        ]);

        expect(validateNormalizedRunSnapshot(malformed, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ path: 'model.cases.0.nativeReferences.0.url' }),
                expect.objectContaining({ path: 'model.cases.0.nativeReferences.0.metadata.nested' }),
            ]),
        });
    });

    it('applies partial versus final completeness and collects identity relationship errors', () => {
        const partial: NormalizedRunSnapshot = {
            version: 1,
            completeness: 'partial',
            model: {
                run: { id: 'run-parked', adapterName: 'durable-adapter', status: 'parked' },
                units: [{ id: 'unit-1', runId: 'run-parked', displayName: 'durable unit' }],
                cases: [{
                    id: 'case-started',
                    runId: 'run-parked',
                    unitId: 'unit-1',
                    name: 'waiting for input',
                    state: 'pending',
                    scoringPolicy: { kind: 'from-evaluations' },
                    attempts: [],
                }],
            },
        };

        expect(validateNormalizedRunSnapshot(partial, { completeness: 'partial' })).toEqual({
            ok: true,
            errors: [],
        });
        expect(() => projectNormalizedRunSnapshotToReportInput(partial)).toThrow(/Expected final snapshot/);

        const completedWithFailedCase = normalizedSnapshot([
            runCase({ id: 'normal-test-failure', state: 'failed', scoringPolicy: { kind: 'score', score: 0 } }),
        ]);
        completedWithFailedCase.model.run.status = 'completed';
        expect(validateNormalizedRunSnapshot(completedWithFailedCase, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });
        expect(buildPathgradeReport(projectNormalizedRunSnapshotToReportInput(completedWithFailedCase)).report.status).toBe('fail');

        const parkedFinal = normalizedSnapshot([
            runCase({ id: 'terminal-parked', state: 'pending', scoringPolicy: { kind: 'non-scoring', reason: 'parked' } }),
        ]);
        parkedFinal.model.run.status = 'parked';
        expect(validateNormalizedRunSnapshot(parkedFinal, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: [expect.objectContaining({ path: 'model.run.diagnostics' })],
        });
        parkedFinal.model.run.diagnostics = [{ severity: 'warning', message: 'terminal parked snapshot' }];
        expect(validateNormalizedRunSnapshot(parkedFinal, { completeness: 'final' })).toEqual({
            ok: true,
            errors: [],
        });

        const malformed = normalizedSnapshot([
            runCase({ id: 'duplicate-case', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [1] }),
            {
                ...runCase({ id: 'duplicate-case', state: 'passed', scoringPolicy: { kind: 'score', score: Number.POSITIVE_INFINITY } }),
                runId: 'missing-run',
                unitId: 'missing-unit',
                attempts: [],
                nativeReferences: [{ kind: 'case', id: 'native-id-is-not-pathgrade-id' }],
            },
        ]);
        malformed.model.units.push({ id: 'unit-1', runId: 'run-1', displayName: 'duplicate unit' });

        expect(validateNormalizedRunSnapshot(malformed, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ path: 'model.units.1.id' }),
                expect.objectContaining({ path: 'model.cases.1.id' }),
                expect.objectContaining({ path: 'model.cases.1.runId' }),
                expect.objectContaining({ path: 'model.cases.1.unitId' }),
                expect.objectContaining({ path: 'model.cases.1.attempts' }),
                expect.objectContaining({ path: 'model.cases.1.scoringPolicy.score' }),
            ]),
        });

        const nativeOnlyIdentity = normalizedSnapshot([]);
        nativeOnlyIdentity.model.run.id = '';
        nativeOnlyIdentity.model.run.nativeReferences = [{ kind: 'run', id: 'native-run-id' }];
        expect(validateNormalizedRunSnapshot(nativeOnlyIdentity, { completeness: 'final' })).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.objectContaining({ path: 'model.run.id' })]),
        });
    });

    it('keeps projected report artifacts compatible for selection threshold summaries and traces', () => {
        const snapshot = normalizedSnapshot([
            runCase({ id: 'selected-pass', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [1] }),
            runCase({ id: 'selected-fail', state: 'failed', scoringPolicy: { kind: 'score', score: 0 } }),
            runCase({ id: 'selected-skip', state: 'skipped', scoringPolicy: { kind: 'non-scoring', reason: 'skipped by runner' } }),
            runCase({ id: 'selected-pending', state: 'pending', scoringPolicy: { kind: 'non-scoring', reason: 'waiting on durable run' } }),
        ]);
        snapshot.model.run.nativeReferences = [{ kind: 'run', url: 'https://example.com/run/1' }];
        snapshot.model.cases[0].attempts[0].assertions = [{
            id: 'selected-assertion',
            attemptId: 'selected-pass-attempt',
            name: 'compatible assertion',
            status: 'passed',
            evidence: 'normalized-only evidence',
        }];

        const reportInput = projectNormalizedRunSnapshotToReportInput(snapshot, {
            selection: {
                base_ref: 'origin/main@abc123',
                changed_files_count: 2,
                selected: ['selected.eval.ts'],
                skipped: ['unselected.eval.ts'],
            },
        });
        const built = buildPathgradeReport({ ...reportInput, threshold: 0.75 });

        expect(built.report).toMatchObject({
            version: 1,
            threshold: 0.75,
            overall_pass_rate: 0.5,
            status: 'fail',
            selection: {
                base_ref: 'origin/main@abc123',
                changed_files_count: 2,
                selected: ['selected.eval.ts'],
                skipped: ['unselected.eval.ts'],
            },
            groups: [{
                task: 'suite label',
                pass_rate: 1 / 2,
                trace_file: 'traces/suite-label.json',
            }],
        });
        expect(built.summaries).toEqual([expect.objectContaining({
            task: 'suite label',
            trial_count: 2,
            average_duration_ms: 1,
        })]);
        expect(built.traces).toEqual([{
            traceFile: 'traces/suite-label.json',
            trials: expect.arrayContaining([
                expect.objectContaining({ name: 'selected-pass', reward: 1 }),
                expect.objectContaining({ name: 'selected-fail', reward: 0 }),
            ]),
        }]);

        const publicArtifact = JSON.stringify({ report: built.report, traces: built.traces });
        expect(publicArtifact).not.toContain('NormalizedRunSnapshot');
        expect(publicArtifact).not.toContain('nativeReferences');
        expect(publicArtifact).not.toContain('normalized-only evidence');
        expect(publicArtifact).not.toContain('assertions');
    });

    it('fits future remote assertion-heavy and durable parked adapter fixtures without new public artifacts', () => {
        const langfuse = normalizedSnapshot([
            {
                ...runCase({ id: 'dataset-item-1', state: 'passed', scoringPolicy: { kind: 'from-evaluations' }, scores: [0.82] }),
                nativeReferences: [{ kind: 'langfuse-dataset-item', id: 'item-1', url: 'https://example.com/langfuse/items/1' }],
                diagnostics: [{ severity: 'info', message: 'remote score imported' }],
            },
        ]);
        langfuse.model.run.adapterName = 'langfuse-like';
        langfuse.model.run.nativeReferences = [{ kind: 'langfuse-run', id: 'run-123', url: 'https://example.com/langfuse/runs/123' }];
        langfuse.model.units[0].displayName = 'Langfuse dataset';
        langfuse.model.units[0].nativeReferences = [{ kind: 'langfuse-dataset', id: 'dataset-1' }];

        const evalforge = normalizedSnapshot([
            {
                ...runCase({ id: 'assertion-heavy', state: 'failed', scoringPolicy: { kind: 'from-evaluations' }, scores: [0.25] }),
                attempts: [{
                    id: 'assertion-heavy-attempt',
                    caseId: 'assertion-heavy',
                    outcome: { kind: 'failed', reason: 'assertions failed' },
                    evaluations: [{ id: 'assertion-heavy-evaluation', attemptId: 'assertion-heavy-attempt', score: 0.25 }],
                    assertions: [
                        { id: 'assertion-a', attemptId: 'assertion-heavy-attempt', name: 'format', status: 'passed', severity: 'info' },
                        { id: 'assertion-b', attemptId: 'assertion-heavy-attempt', name: 'grounding', status: 'failed', severity: 'error', evidence: 'normalized only' },
                    ],
                }],
            },
        ]);
        evalforge.model.run.adapterName = 'evalforge-like';

        const evePartial: NormalizedRunSnapshot = {
            version: 1,
            completeness: 'partial',
            model: {
                run: {
                    id: 'eve-run',
                    adapterName: 'eve-like',
                    status: 'parked',
                    nativeReferences: [{ kind: 'eve-session', id: 'session-1', url: 'https://example.com/eve/sessions/1' }],
                },
                units: [{ id: 'eve-unit', runId: 'eve-run', displayName: 'Eve durable session' }],
                cases: [{
                    id: 'eve-pending',
                    runId: 'eve-run',
                    unitId: 'eve-unit',
                    name: 'waiting for human input',
                    state: 'pending',
                    scoringPolicy: { kind: 'non-scoring', reason: 'parked waiting for input' },
                    attempts: [],
                }],
            },
        };

        expect(validateNormalizedRunSnapshot(langfuse, { completeness: 'final' })).toEqual({ ok: true, errors: [] });
        expect(validateNormalizedRunSnapshot(evalforge, { completeness: 'final' })).toEqual({ ok: true, errors: [] });
        expect(validateNormalizedRunSnapshot(evePartial, { completeness: 'partial' })).toEqual({ ok: true, errors: [] });
        expect(() => projectNormalizedRunSnapshotToReportInput(evePartial)).toThrow(/Expected final snapshot/);

        const langfuseReport = buildPathgradeReport(projectNormalizedRunSnapshotToReportInput(langfuse)).report;
        const evalforgeReport = buildPathgradeReport(projectNormalizedRunSnapshotToReportInput(evalforge)).report;

        expect(langfuseReport).toMatchObject({
            overall_pass_rate: 0.82,
            groups: [{ task: 'suite label', pass_rate: 1 }],
        });
        expect(evalforgeReport).toMatchObject({
            overall_pass_rate: 0.25,
            groups: [{ task: 'suite label', pass_rate: 0 }],
        });
        expect(JSON.stringify({ langfuseReport, evalforgeReport })).not.toContain('normalized only');
        expect(fs.existsSync(path.join(process.cwd(), 'src/adapters/langfuse'))).toBe(false);
        expect(fs.existsSync(path.join(process.cwd(), 'src/adapters/evalforge'))).toBe(false);
        expect(fs.existsSync(path.join(process.cwd(), 'src/adapters/eve'))).toBe(false);
        expect(fs.readFileSync(path.join(process.cwd(), 'src/runners/model.ts'), 'utf8')).not.toContain('foldRunEvents');
    });
});

function normalizedSnapshot(cases: RunCaseRecord[]): NormalizedRunSnapshot {
    return {
        version: 1,
        completeness: 'final',
        model: {
            run: { id: 'run-1', adapterName: 'fake-adapter', status: 'completed' },
            units: [{
                id: 'unit-1', runId: 'run-1', displayName: 'unit label',
                groupingHints: [{ kind: 'suite', key: 'suite', label: 'suite label', order: 1 }],
            }],
            cases,
        },
    };
}

function runCase(input: { id: string; state: RunCaseRecord['state']; scoringPolicy: RunCaseRecord['scoringPolicy']; scores?: number[] }): RunCaseRecord {
    return {
        id: input.id, runId: 'run-1', unitId: 'unit-1', name: input.id, state: input.state,
        scoringPolicy: input.scoringPolicy,
        groupingHints: [{ kind: 'suite', key: 'suite', label: 'suite label', order: 1 }],
        attempts: [{
            id: `${input.id}-attempt`, caseId: input.id,
            outcome: input.state === 'passed' ? { kind: 'passed' } : input.state === 'failed' ? { kind: 'failed' } : { kind: 'not-run', reason: input.state },
            durationMs: 1,
            evaluations: (input.scores ?? []).map((score, index) => ({ id: `${input.id}-evaluation-${index}`, attemptId: `${input.id}-attempt`, score })),
        }],
    };
}
