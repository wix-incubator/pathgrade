import type { DiagnosticsReport } from '../sdk/diagnostics.js';
import type { TrialResult } from '../types.js';

export interface NormalizedRunSnapshot {
    version: 1;
    completeness: SnapshotCompleteness;
    model: NormalizedRunModel;
}

export type SnapshotCompleteness = 'partial' | 'final';

export interface NormalizedRunModel {
    run: RunRecord;
    units: EvalUnitRecord[];
    cases: RunCaseRecord[];
}

export type RunStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'parked';

export interface RunRecord {
    id: string;
    adapterName: string;
    status: RunStatus;
    diagnostics?: Diagnostic[];
    nativeReferences?: NativeReference[];
}

export interface EvalUnitRecord {
    id: string;
    runId: string;
    displayName: string;
    diagnostics?: Diagnostic[];
    nativeReferences?: NativeReference[];
    groupingHints?: GroupingHint[];
}

export type RunCaseState = 'passed' | 'failed' | 'skipped' | 'pending';

export type ScoringPolicy =
    | { kind: 'score'; score: number }
    | { kind: 'non-scoring'; reason: string }
    | { kind: 'from-evaluations' };

export interface RunCaseRecord {
    id: string;
    runId: string;
    unitId?: string;
    name: string;
    state: RunCaseState;
    scoringPolicy: ScoringPolicy;
    attempts: AttemptRecord[];
    groupingHints?: GroupingHint[];
    diagnostics?: Diagnostic[];
    nativeReferences?: NativeReference[];
}

export type AttemptOutcome =
    | { kind: 'passed' }
    | { kind: 'failed'; reason?: string }
    | { kind: 'errored'; reason?: string }
    | { kind: 'timed-out'; durationMs?: number }
    | { kind: 'cancelled'; reason?: string }
    | { kind: 'not-run'; reason: 'skipped' | 'pending' | 'filtered' };

export interface AttemptRecord {
    id: string;
    caseId: string;
    outcome: AttemptOutcome;
    durationMs?: number;
    evaluations?: EvaluationRecord[];
    assertions?: AssertionRecord[];
    diagnostics?: Diagnostic[];
}

export interface EvaluationRecord {
    id: string;
    attemptId: string;
    score: number;
    name?: string;
    diagnostics?: DiagnosticsReport;
    trial?: TrialResult;
    nativeReferences?: NativeReference[];
}

export interface AssertionRecord {
    id: string;
    attemptId: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'unknown';
    severity?: 'info' | 'warning' | 'error' | 'fatal';
    message?: string;
    evidence?: string;
    nativeReferences?: NativeReference[];
}

export interface Diagnostic {
    severity: 'info' | 'warning' | 'error';
    message: string;
    code?: string;
    detail?: string;
    nativeReferences?: NativeReference[];
}

export interface NativeReference {
    kind: string;
    id?: string;
    label?: string;
    url?: string;
    metadata?: Record<string, string | number | boolean | null>;
}

export interface GroupingHint {
    kind: 'source' | 'suite' | 'dataset' | 'adapter' | 'custom';
    key: string;
    label: string;
    order?: number;
}
