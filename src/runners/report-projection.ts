import type { ReportGroupInput, ReportRunInput } from '../reporting/types.js';
import type { PathgradeSelectionReport } from '../types.js';
import { validateNormalizedRunSnapshot } from './model-validation.js';
import type { EvaluationRecord, GroupingHint, NormalizedRunSnapshot, RunCaseRecord } from './model.js';

export function projectNormalizedRunSnapshotToReportInput(
    snapshot: NormalizedRunSnapshot,
    options: { selection?: PathgradeSelectionReport } = {},
): ReportRunInput {
    const validation = validateNormalizedRunSnapshot(snapshot, { completeness: 'final' });
    if (!validation.ok) {
        throw new Error(`Invalid normalized run snapshot: ${validation.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
    }

    const unitsById = new Map(snapshot.model.units.map(unit => [unit.id, unit]));
    const groups = new Map<string, ReportGroupInput>();

    for (const runCase of snapshot.model.cases) {
        if (runCase.scoringPolicy.kind === 'non-scoring' && runCase.state !== 'skipped' && runCase.state !== 'pending') {
            continue;
        }

        const unit = runCase.unitId ? unitsById.get(runCase.unitId) : undefined;
        const groupName = preferredGroupingLabel(runCase.groupingHints)
            ?? preferredGroupingLabel(unit?.groupingHints)
            ?? unit?.displayName;
        const key = groupName ?? snapshot.model.run.adapterName;
        const group = groups.get(key) ?? { groupName: key, cases: [] };
        group.cases.push({
            caseId: runCase.id,
            name: runCase.name,
            state: runCase.state,
            ...(runCase.state === 'skipped' || runCase.state === 'pending' ? { reportable: runCase.scoringPolicy.kind !== 'non-scoring' } : {}),
            runnerDurationMs: totalDurationMs(runCase),
            evaluations: projectedEvaluations(runCase),
        });
        groups.set(key, group);
    }

    return {
        ...(options.selection ? { selection: options.selection } : {}),
        groups: [...groups.values()],
    };
}

function totalDurationMs(runCase: RunCaseRecord): number {
    return runCase.attempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0);
}

function projectedEvaluations(runCase: RunCaseRecord): Array<{ score: number; trial?: EvaluationRecord['trial']; diagnostics?: EvaluationRecord['diagnostics'] }> {
    if (runCase.scoringPolicy.kind === 'non-scoring') {
        return runCase.attempts.flatMap(attempt => (attempt.evaluations ?? []).map(evaluation => ({
            score: evaluation.score,
            ...(evaluation.trial ? { trial: evaluation.trial } : {}),
            ...(evaluation.diagnostics ? { diagnostics: evaluation.diagnostics } : {}),
        })));
    }

    if (runCase.scoringPolicy.kind === 'score') {
        return [{ score: runCase.scoringPolicy.score }];
    }

    const evaluation = runCase.attempts.flatMap(attempt => attempt.evaluations ?? []).at(-1);
    if (!evaluation) return [];

    return [{
        score: evaluation.score,
        ...(evaluation.trial ? { trial: evaluation.trial } : {}),
        ...(evaluation.diagnostics ? { diagnostics: evaluation.diagnostics } : {}),
    }];
}

function preferredGroupingLabel(hints: GroupingHint[] | undefined): string | undefined {
    return hints
        ?.toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .at(0)
        ?.label;
}
