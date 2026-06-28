import type { ReportGroupInput } from '../reporting/types.js';
import type { AdapterRunHandle } from './adapter.js';
import type { AttemptOutcome, EvaluationRecord, NormalizedRunSnapshot, RunCaseRecord, ScoringPolicy } from './model.js';

export function buildNormalizedRunSnapshotFromReportGroups(
    run: AdapterRunHandle,
    groups: ReportGroupInput[],
): NormalizedRunSnapshot {
    return {
        version: 1,
        completeness: 'final',
        model: {
            run: {
                id: `${run.adapterName}:run`,
                adapterName: run.adapterName,
                status: run.status,
                ...(run.diagnostics ? { diagnostics: run.diagnostics.map(diagnostic => ({
                    severity: diagnostic.severity,
                    message: diagnostic.message,
                })) } : {}),
            },
            units: groups.map((group, index) => ({
                id: unitId(group.groupName, index),
                runId: `${run.adapterName}:run`,
                displayName: group.groupName,
                groupingHints: [{ kind: 'suite', key: group.groupName, label: group.groupName, order: index }],
            })),
            cases: groups.flatMap((group, groupIndex) => group.cases.map((testCase, caseIndex): RunCaseRecord => {
                const caseId = testCase.caseId ?? `${unitId(group.groupName, groupIndex)}:case-${caseIndex + 1}`;
                const attemptId = `${caseId}:attempt-1`;
                const evaluations = testCase.evaluations?.map((evaluation, evaluationIndex): EvaluationRecord => ({
                    id: `${attemptId}:evaluation-${evaluationIndex + 1}`,
                    attemptId,
                    score: evaluation.score,
                    ...(evaluation.trial ? { trial: evaluation.trial } : {}),
                    ...(evaluation.diagnostics ? { diagnostics: evaluation.diagnostics } : {}),
                }));

                return {
                    id: caseId,
                    runId: `${run.adapterName}:run`,
                    unitId: unitId(group.groupName, groupIndex),
                    name: testCase.name,
                    state: testCase.state,
                    scoringPolicy: scoringPolicyForCase(testCase.state, evaluations),
                    groupingHints: [{ kind: 'suite', key: group.groupName, label: group.groupName, order: groupIndex }],
                    attempts: [{
                        id: attemptId,
                        caseId,
                        outcome: outcomeForCase(testCase.state),
                        durationMs: testCase.runnerDurationMs,
                        ...(evaluations ? { evaluations } : {}),
                    }],
                };
            })),
        },
    };
}

function unitId(groupName: string, index: number): string {
    return `unit-${index + 1}:${groupName}`;
}

function scoringPolicyForCase(
    state: RunCaseRecord['state'],
    evaluations: EvaluationRecord[] | undefined,
): ScoringPolicy {
    if (state === 'skipped' || state === 'pending') return { kind: 'non-scoring', reason: state };
    if (evaluations && evaluations.length > 0) return { kind: 'from-evaluations' };
    return { kind: 'score', score: state === 'passed' ? 1 : 0 };
}

function outcomeForCase(state: RunCaseRecord['state']): AttemptOutcome {
    if (state === 'passed') return { kind: 'passed' };
    if (state === 'failed') return { kind: 'failed' };
    return { kind: 'not-run', reason: state };
}
