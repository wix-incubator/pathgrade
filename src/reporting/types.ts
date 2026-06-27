import type { DiagnosticsReport } from '../sdk/diagnostics.js';
import type { PathgradeReport, PathgradeSelectionReport, TrialResult } from '../types.js';

export type ReportCaseState = 'passed' | 'failed' | 'skipped' | 'pending';

export interface ReportRunInput {
    threshold?: number;
    selection?: PathgradeSelectionReport;
    groups: ReportGroupInput[];
}

export interface ReportGroupInput {
    groupName: string;
    cases: ReportCaseInput[];
}

export interface ReportCaseInput {
    caseId?: string;
    name: string;
    state: ReportCaseState;
    runnerDurationMs: number;
    sourceRef?: string;
    filePath?: string;
    groupName?: string;
    runnerCaseId?: string;
    evaluations?: readonly ReportEvaluationInput[];
    diagnostics?: DiagnosticsReport;
}

export interface ReportEvaluationInput {
    score: number;
    trial?: TrialResult;
    diagnostics?: DiagnosticsReport;
}

export interface PathgradeReportBuildResult {
    report: PathgradeReport;
    traces: Array<{ traceFile: string; trials: TrialResult[] }>;
    summaries: ReportSummaryGroup[];
    warnings: string[];
}

export interface ArtifactWriteResult {
    resultsPath: string;
    traceFiles: string[];
}

export interface ReportSummaryGroup {
    task: string;
    pass_rate: number;
    pass_at_k: number;
    pass_pow_k: number;
    average_duration_ms: number;
    trial_count: number;
    diagnostics: ReportSummaryDiagnostics[];
}

export interface ReportSummaryDiagnostics {
    caseName: string;
    state: ReportCaseState;
    report: DiagnosticsReport;
}
