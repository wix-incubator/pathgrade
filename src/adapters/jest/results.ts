import type {
    AdapterRunHandle,
    AttemptOutcome,
    EvaluationRecord,
    NormalizedRunSnapshot,
    PathgradeTestMeta,
    RunCaseRecord,
    RunCaseState,
    ScoringPolicy,
} from '@wix/pathgrade/adapter-kit';

export interface JestAggregatedResult {
    testResults?: JestFileResult[];
}

export interface JestFileResult {
    testFilePath: string;
    assertionResults?: JestAssertionResult[];
    testResults?: JestAssertionResult[];
}

export interface JestAssertionResult {
    ancestorTitles?: string[];
    title: string;
    fullName?: string;
    status: string;
    duration?: number | null;
    failureMessages?: string[];
    location?: { line?: number | null; column?: number | null } | null;
}

export function normalizeJestRunResults(input: {
    run: AdapterRunHandle;
    results: JestAggregatedResult;
    metadataByCaseId?: Map<string, PathgradeTestMeta[]>;
}): NormalizedRunSnapshot {
    const runId = `${input.run.adapterName}:run`;
    const files = input.results.testResults ?? [];
    const units = files.map((fileResult, index) => ({
        id: unitId(index),
        runId,
        displayName: fileResult.testFilePath,
        groupingHints: [{
            kind: 'source' as const,
            key: fileResult.testFilePath,
            label: fileResult.testFilePath,
            order: index,
        }],
        nativeReferences: [{ kind: 'jest-file', id: fileResult.testFilePath }],
    }));
    const occurrenceCounts = new Map<string, number>();

    return {
        version: 1,
        completeness: 'final',
        model: {
            run: {
                id: runId,
                adapterName: input.run.adapterName,
                status: input.run.status,
            },
            units,
            cases: files.flatMap((fileResult, fileIndex) => assertionsForFile(fileResult).map(assertion => {
                const caseId = jestCaseId({
                    filePath: fileResult.testFilePath,
                    fullName: assertion.fullName ?? fullCaseName(assertion),
                    occurrenceCounts,
                });
                return runCase({
                    runId,
                    unitId: unitId(fileIndex),
                    caseId,
                    assertion,
                    filePath: fileResult.testFilePath,
                    evaluations: input.metadataByCaseId?.get(caseId) ?? [],
                });
            })),
        },
    };
}

function assertionsForFile(fileResult: JestFileResult): JestAssertionResult[] {
    return fileResult.assertionResults ?? fileResult.testResults ?? [];
}

export function jestCaseId(input: {
    filePath: string;
    fullName: string;
    occurrenceCounts?: Map<string, number>;
}): string {
    const base = `jest:${input.filePath}:${slug(input.fullName)}`;
    const current = input.occurrenceCounts?.get(base) ?? 0;
    const occurrence = current + 1;
    input.occurrenceCounts?.set(base, occurrence);
    return `${base}:${occurrence}`;
}

function runCase(input: {
    runId: string;
    unitId: string;
    caseId: string;
    filePath: string;
    assertion: JestAssertionResult;
    evaluations: PathgradeTestMeta[];
}): RunCaseRecord {
    const state = normalizeState(input.assertion.status);
    const attemptId = `${input.caseId}:attempt-1`;
    const evaluations = input.evaluations.map((entry, index): EvaluationRecord => ({
        id: `${attemptId}:evaluation-${index + 1}`,
        attemptId,
        score: entry.score,
        ...(entry.trial ? { trial: entry.trial } : {}),
        ...(entry.diagnostics ? { diagnostics: entry.diagnostics } : {}),
    }));
    const failureMessage = input.assertion.failureMessages?.find(message => message.trim().length > 0);

    return {
        id: input.caseId,
        runId: input.runId,
        unitId: input.unitId,
        name: fullCaseName(input.assertion),
        state,
        scoringPolicy: scoringPolicyForCase(state, evaluations),
        groupingHints: [{
            kind: 'source',
            key: input.filePath,
            label: input.filePath,
            order: 0,
        }],
        nativeReferences: [{
            kind: 'jest-case',
            id: input.caseId,
            metadata: {
                status: input.assertion.status,
                ...(input.assertion.location?.line ? { line: input.assertion.location.line } : {}),
                ...(input.assertion.location?.column ? { column: input.assertion.location.column } : {}),
            },
        }],
        attempts: [{
            id: attemptId,
            caseId: input.caseId,
            outcome: outcomeForCase(state, failureMessage),
            durationMs: input.assertion.duration ?? 0,
            ...(evaluations.length > 0 ? { evaluations } : {}),
            ...(failureMessage ? {
                assertions: [{
                    id: `${attemptId}:assertion-1`,
                    attemptId,
                    name: 'Jest assertion failure',
                    status: 'failed',
                    severity: 'error',
                    message: failureMessage,
                }],
            } : {}),
        }],
    };
}

function fullCaseName(assertion: JestAssertionResult): string {
    const ancestors = assertion.ancestorTitles ?? [];
    return [...ancestors, assertion.title].filter(Boolean).join(' > ');
}

function normalizeState(status: string): RunCaseState {
    if (status === 'passed') return 'passed';
    if (status === 'skipped') return 'skipped';
    if (status === 'pending' || status === 'todo' || status === 'disabled') return 'pending';
    return 'failed';
}

function scoringPolicyForCase(
    state: RunCaseState,
    evaluations: EvaluationRecord[],
): ScoringPolicy {
    if (state === 'skipped' || state === 'pending') return { kind: 'non-scoring', reason: state };
    if (evaluations.length > 0) return { kind: 'from-evaluations' };
    return { kind: 'score', score: state === 'passed' ? 1 : 0 };
}

function outcomeForCase(state: RunCaseState, failureMessage: string | undefined): AttemptOutcome {
    if (state === 'passed') return { kind: 'passed' };
    if (state === 'failed') return { kind: 'failed', ...(failureMessage ? { reason: failureMessage } : {}) };
    return { kind: 'not-run', reason: state };
}

function unitId(index: number): string {
    return `jest:unit-${index + 1}`;
}

function slug(value: string): string {
    const clean = value
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '');
    return clean || 'case';
}
