import type { NativeReference, NormalizedRunSnapshot, SnapshotCompleteness } from './model.js';

export interface NormalizedRunValidationResult {
    ok: boolean;
    errors: NormalizedRunValidationError[];
}

export interface NormalizedRunValidationError {
    path: string;
    message: string;
}

export function validateNormalizedRunSnapshot(
    snapshot: NormalizedRunSnapshot,
    options: { completeness: SnapshotCompleteness },
): NormalizedRunValidationResult {
    const errors: NormalizedRunValidationError[] = [];

    if (snapshot.version !== 1) {
        errors.push({ path: 'version', message: 'Normalized run snapshot version must be 1.' });
    }
    if (snapshot.completeness !== options.completeness) {
        errors.push({ path: 'completeness', message: `Expected ${options.completeness} snapshot.` });
    }
    if (!snapshot.model.run.id) {
        errors.push({ path: 'model.run.id', message: 'Run id is required.' });
    }
    if (!snapshot.model.run.adapterName) {
        errors.push({ path: 'model.run.adapterName', message: 'Run adapterName is required.' });
    }
    if (options.completeness === 'final' && snapshot.model.run.status === 'parked' && (snapshot.model.run.diagnostics ?? []).length === 0) {
        errors.push({ path: 'model.run.diagnostics', message: 'Final parked snapshots require diagnostics explaining why parked is terminal.' });
    }
    validateNativeReferences(snapshot.model.run.nativeReferences, 'model.run.nativeReferences', errors);
    for (const [diagnosticIndex, diagnostic] of (snapshot.model.run.diagnostics ?? []).entries()) {
        validateNativeReferences(diagnostic.nativeReferences, `model.run.diagnostics.${diagnosticIndex}.nativeReferences`, errors);
    }

    const unitIds = new Set<string>();
    for (const [unitIndex, unit] of snapshot.model.units.entries()) {
        if (!unit.id) {
            errors.push({ path: `model.units.${unitIndex}.id`, message: 'Eval unit id is required.' });
        } else if (unitIds.has(unit.id)) {
            errors.push({ path: `model.units.${unitIndex}.id`, message: 'Eval unit id must be unique.' });
        } else {
            unitIds.add(unit.id);
        }
        if (unit.runId !== snapshot.model.run.id) {
            errors.push({ path: `model.units.${unitIndex}.runId`, message: 'Eval unit runId must reference the run.' });
        }
        if (!unit.displayName) {
            errors.push({ path: `model.units.${unitIndex}.displayName`, message: 'Eval unit displayName is required.' });
        }
        validateNativeReferences(unit.nativeReferences, `model.units.${unitIndex}.nativeReferences`, errors);
        for (const [diagnosticIndex, diagnostic] of (unit.diagnostics ?? []).entries()) {
            validateNativeReferences(diagnostic.nativeReferences, `model.units.${unitIndex}.diagnostics.${diagnosticIndex}.nativeReferences`, errors);
        }
    }

    const caseIds = new Set<string>();
    const attemptIds = new Set<string>();
    const evaluationIds = new Set<string>();
    const assertionIds = new Set<string>();
    for (const [caseIndex, runCase] of snapshot.model.cases.entries()) {
        if (!runCase.id) {
            errors.push({ path: `model.cases.${caseIndex}.id`, message: 'Run case id is required.' });
        } else if (caseIds.has(runCase.id)) {
            errors.push({ path: `model.cases.${caseIndex}.id`, message: 'Run case id must be unique.' });
        } else {
            caseIds.add(runCase.id);
        }
        if (runCase.runId !== snapshot.model.run.id) {
            errors.push({ path: `model.cases.${caseIndex}.runId`, message: 'Run case runId must reference the run.' });
        }
        if (runCase.unitId && !unitIds.has(runCase.unitId)) {
            errors.push({ path: `model.cases.${caseIndex}.unitId`, message: 'Run case unitId must reference an eval unit.' });
        }
        if (!runCase.name) {
            errors.push({ path: `model.cases.${caseIndex}.name`, message: 'Run case name is required.' });
        }
        validateNativeReferences(runCase.nativeReferences, `model.cases.${caseIndex}.nativeReferences`, errors);
        for (const [diagnosticIndex, diagnostic] of (runCase.diagnostics ?? []).entries()) {
            validateNativeReferences(diagnostic.nativeReferences, `model.cases.${caseIndex}.diagnostics.${diagnosticIndex}.nativeReferences`, errors);
        }
        if (options.completeness === 'final' && runCase.attempts.length === 0) {
            errors.push({ path: `model.cases.${caseIndex}.attempts`, message: 'Final run cases require at least one attempt.' });
        }
        const evaluations = runCase.attempts.flatMap(attempt => attempt.evaluations ?? []);
        if (runCase.scoringPolicy.kind === 'from-evaluations' && options.completeness === 'final' && evaluations.length === 0) {
            errors.push({ path: `model.cases.${caseIndex}.scoringPolicy`, message: 'from-evaluations scoring requires at least one evaluation.' });
        }
        if (runCase.scoringPolicy.kind === 'score' && (!Number.isFinite(runCase.scoringPolicy.score) || runCase.scoringPolicy.score < 0 || runCase.scoringPolicy.score > 1)) {
            errors.push({ path: `model.cases.${caseIndex}.scoringPolicy.score`, message: 'Scoring policy score must be a finite number in [0, 1].' });
        }
        if (runCase.scoringPolicy.kind === 'non-scoring' && runCase.scoringPolicy.reason.trim() === '') {
            errors.push({ path: `model.cases.${caseIndex}.scoringPolicy.reason`, message: 'Non-scoring cases require a reason.' });
        }

        for (const [attemptIndex, attempt] of runCase.attempts.entries()) {
            if (!attempt.id) {
                errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.id`, message: 'Attempt id is required.' });
            } else if (attemptIds.has(attempt.id)) {
                errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.id`, message: 'Attempt id must be unique.' });
            } else {
                attemptIds.add(attempt.id);
            }
            if (attempt.caseId !== runCase.id) {
                errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.caseId`, message: 'Attempt caseId must reference its run case.' });
            }
            if ((runCase.state === 'skipped' || runCase.state === 'pending') && attempt.outcome.kind !== 'not-run') {
                errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.outcome`, message: 'Non-executed final cases require a not-run attempt outcome.' });
            }
            for (const [diagnosticIndex, diagnostic] of (attempt.diagnostics ?? []).entries()) {
                validateNativeReferences(diagnostic.nativeReferences, `model.cases.${caseIndex}.attempts.${attemptIndex}.diagnostics.${diagnosticIndex}.nativeReferences`, errors);
            }
            for (const [evaluationIndex, evaluation] of (attempt.evaluations ?? []).entries()) {
                if (!evaluation.id) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.evaluations.${evaluationIndex}.id`, message: 'Evaluation id is required.' });
                } else if (evaluationIds.has(evaluation.id)) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.evaluations.${evaluationIndex}.id`, message: 'Evaluation id must be unique.' });
                } else {
                    evaluationIds.add(evaluation.id);
                }
                if (evaluation.attemptId !== attempt.id) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.evaluations.${evaluationIndex}.attemptId`, message: 'Evaluation attemptId must reference its attempt.' });
                }
                if (!Number.isFinite(evaluation.score) || evaluation.score < 0 || evaluation.score > 1) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.evaluations.${evaluationIndex}.score`, message: 'Evaluation score must be a finite number in [0, 1].' });
                }
                validateNativeReferences(evaluation.nativeReferences, `model.cases.${caseIndex}.attempts.${attemptIndex}.evaluations.${evaluationIndex}.nativeReferences`, errors);
            }
            for (const [assertionIndex, assertion] of (attempt.assertions ?? []).entries()) {
                if (!assertion.id) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.assertions.${assertionIndex}.id`, message: 'Assertion id is required.' });
                } else if (assertionIds.has(assertion.id)) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.assertions.${assertionIndex}.id`, message: 'Assertion id must be unique.' });
                } else {
                    assertionIds.add(assertion.id);
                }
                if (assertion.attemptId !== attempt.id) {
                    errors.push({ path: `model.cases.${caseIndex}.attempts.${attemptIndex}.assertions.${assertionIndex}.attemptId`, message: 'Assertion attemptId must reference its attempt.' });
                }
                validateNativeReferences(assertion.nativeReferences, `model.cases.${caseIndex}.attempts.${attemptIndex}.assertions.${assertionIndex}.nativeReferences`, errors);
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

function validateNativeReferences(
    references: NativeReference[] | undefined,
    path: string,
    errors: NormalizedRunValidationError[],
): void {
    for (const [index, reference] of (references ?? []).entries()) {
        const referencePath = `${path}.${index}`;
        if (!reference.kind) {
            errors.push({ path: `${referencePath}.kind`, message: 'Native reference kind is required.' });
        }
        if (reference.url && !isSafeUrl(reference.url)) {
            errors.push({ path: `${referencePath}.url`, message: 'Native reference URL must use http: or https:.' });
        }
        for (const [key, value] of Object.entries(reference.metadata ?? {})) {
            if (
                value !== null
                && typeof value !== 'string'
                && typeof value !== 'number'
                && typeof value !== 'boolean'
            ) {
                errors.push({ path: `${referencePath}.metadata.${key}`, message: 'Native reference metadata values must be flat primitives.' });
            }
        }
    }
}

function isSafeUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}
