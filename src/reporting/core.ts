import type { DiagnosticsReport } from '../sdk/diagnostics.js';
import { extractSkillsFromLog } from '../tool-events.js';
import type { EvalReport, PathgradeGroupReport, StrippedTrialResult, TrialResult } from '../types.js';
import type { PathgradeReportBuildResult, ReportCaseInput, ReportCaseState, ReportRunInput, ReportSummaryGroup } from './types.js';

interface BuiltCase {
    name: string;
    state: ReportCaseState;
    score: number;
    runnerDurationMs: number;
    trial: TrialResult;
    diagnostics?: DiagnosticsReport;
    warnings: string[];
}

export function buildPathgradeReport(input: ReportRunInput): PathgradeReportBuildResult {
    const warnings: string[] = [];
    const consolidatedGroups: PathgradeGroupReport[] = [];
    const traces: PathgradeReportBuildResult['traces'] = [];
    const summaries: ReportSummaryGroup[] = [];
    const builtGroups = input.groups.map(group => ({
        groupName: group.groupName,
        cases: group.cases.map(toBuiltCase),
    }));

    for (const group of builtGroups) {
        for (const testCase of group.cases) {
            warnings.push(...testCase.warnings);
        }
    }

    const reportableGroups = builtGroups
        .map(group => ({
            ...group,
            cases: group.cases.filter(reportableBuiltCase),
        }))
        .filter(group => group.cases.length > 0);

    for (const group of reportableGroups) {
        const report = buildEvalReport(group.groupName, group.cases);
        summaries.push(buildSummary(group.groupName, group.cases, report));
        const traceFile = `traces/${slug(group.groupName)}.json`;
        traces.push({ traceFile, trials: report.trials });

        const strippedTrials: StrippedTrialResult[] = report.trials.map(trial => {
            const { session_log, conversation, ...rest } = trial;
            return rest;
        });
        const { trials: _trials, ...rest } = report;
        consolidatedGroups.push({
            ...rest,
            trials: strippedTrials,
            trace_file: traceFile,
        });
    }

    const scores = reportableGroups.flatMap(group => group.cases.map(testCase => testCase.score));
    const overallPassRate = average(scores);
    const scoreStatus = input.threshold != null
        ? (overallPassRate >= input.threshold ? 'pass' : 'fail')
        : (reportableGroups.every(group => group.cases.every(testCase => testCase.state === 'passed')) ? 'pass' : 'fail');
    const runPassed = input.run == null
        || (input.run.reason === 'passed' && input.run.failures.length === 0);
    const status = scoreStatus === 'pass' && runPassed ? 'pass' : 'fail';

    return {
        report: {
            version: 1,
            timestamp: new Date().toISOString(),
            ...(input.threshold != null ? { threshold: input.threshold } : {}),
            overall_pass_rate: overallPassRate,
            status,
            groups: consolidatedGroups,
            ...(input.run ? { run: input.run } : {}),
            ...(input.selection ? { selection: input.selection } : {}),
        },
        traces,
        summaries,
        warnings,
    };
}

function reportableBuiltCase(testCase: BuiltCase): boolean {
    return testCase.state !== 'skipped' && testCase.state !== 'pending';
}

function toBuiltCase(testCase: ReportCaseInput): BuiltCase {
    if (testCase.evaluations === undefined) {
        return fallbackCase(testCase, []);
    }

    if (testCase.evaluations.length === 0) {
        return fallbackCase(testCase, [
            `empty results for "${testCase.name}" — evaluate() may not have been called`,
        ]);
    }

    const evaluation = testCase.evaluations[testCase.evaluations.length - 1];
    const diagnostics = evaluation.diagnostics ?? testCase.diagnostics;
    return {
        name: testCase.name,
        state: testCase.state,
        score: evaluation.score,
        runnerDurationMs: testCase.runnerDurationMs,
        diagnostics,
        trial: normalizeTrial({
            name: testCase.name,
            score: evaluation.score,
            runnerDurationMs: testCase.runnerDurationMs,
            trial: evaluation.trial,
            diagnostics,
        }),
        warnings: [],
    };
}

function fallbackCase(testCase: ReportCaseInput, warnings: string[]): BuiltCase {
    const score = testCase.state === 'passed' ? 1 : 0;
    return {
        name: testCase.name,
        state: testCase.state,
        score,
        runnerDurationMs: testCase.runnerDurationMs,
        diagnostics: testCase.diagnostics,
        trial: normalizeTrial({
            name: testCase.name,
            score,
            runnerDurationMs: testCase.runnerDurationMs,
            diagnostics: testCase.diagnostics,
        }),
        warnings,
    };
}

function normalizeTrial(input: {
    name: string;
    score: number;
    runnerDurationMs: number;
    trial?: TrialResult;
    diagnostics?: DiagnosticsReport;
}): TrialResult {
    const base = input.trial ?? {
        trial_id: 1,
        reward: input.score,
        scorer_results: [],
        duration_ms: input.runnerDurationMs,
        n_commands: 0,
        input_tokens: 0,
        output_tokens: 0,
        session_log: [],
    };
    const skills = base.skills_used ?? extractSkillsFromLog(base.session_log);

    return {
        ...base,
        name: input.name,
        duration_ms: base.duration_ms || input.runnerDurationMs,
        diagnostics: input.diagnostics ?? base.diagnostics,
        ...(skills.length > 0 ? { skills_used: skills } : {}),
    };
}

function buildEvalReport(groupName: string, cases: BuiltCase[]): EvalReport {
    const trials = cases.map((testCase, index) => ({
        ...testCase.trial,
        trial_id: index + 1,
    }));
    const passRate = average(cases.map(testCase => testCase.state === 'passed' ? 1 : 0));
    const skills = new Set<string>();
    for (const trial of trials) {
        for (const skill of trial.skills_used ?? []) {
            skills.add(skill);
        }
    }

    return {
        task: groupName,
        pass_rate: passRate,
        pass_at_k: 1 - Math.pow(1 - passRate, trials.length),
        pass_pow_k: Math.pow(passRate, trials.length),
        trials,
        skills_used: [...skills],
    };
}

function buildSummary(groupName: string, cases: BuiltCase[], report: EvalReport): ReportSummaryGroup {
    return {
        task: groupName,
        pass_rate: report.pass_rate,
        pass_at_k: report.pass_at_k,
        pass_pow_k: report.pass_pow_k,
        average_duration_ms: average(cases.map(testCase => testCase.runnerDurationMs)),
        trial_count: cases.length,
        diagnostics: cases.flatMap(testCase => testCase.diagnostics
            ? [{ caseName: testCase.name, state: testCase.state, report: testCase.diagnostics }]
            : []),
    };
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'report';
}
