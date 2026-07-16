import type { Reporter, TestCase, TestModule, TestRunEndReason, TestSuite } from 'vitest/node';
import type { PathgradeTestMeta } from '../sdk/types.js';
import type { PathgradeRunFailure, PathgradeRunResult } from '../types.js';
import type { ReportCaseInput, ReportCaseState, ReportGroupInput } from './types.js';

type VitestRunError = Parameters<NonNullable<Reporter['onTestRunEnd']>>[1][number];

export function collectVitestReportGroups(testModules: ReadonlyArray<TestModule>): ReportGroupInput[] {
    const groupMap = new Map<string, ReportCaseInput[]>();

    for (const mod of testModules) {
        for (const testCase of mod.children.allTests()) {
            const groupName = getGroupName(testCase);
            const entry = toReportCaseInput(testCase);
            if (!groupMap.has(groupName)) {
                groupMap.set(groupName, []);
            }
            groupMap.get(groupName)!.push(entry);
        }
    }

    return Array.from(groupMap.entries()).map(([groupName, cases]) => ({
        groupName,
        cases,
    }));
}

export function collectVitestRunResult(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<VitestRunError>,
    reason: TestRunEndReason,
): PathgradeRunResult {
    const failures: PathgradeRunFailure[] = [];

    for (const mod of testModules) {
        const file = mod.relativeModuleId || undefined;
        appendFailures(failures, getErrors(mod), { scope: 'module', file });

        const suites = mod.children.allSuites?.();
        if (suites) {
            for (const suite of suites) {
                appendFailures(failures, getErrors(suite), {
                    scope: 'suite',
                    file,
                    suite: suite.fullName,
                });
            }
        }
    }

    appendFailures(failures, unhandledErrors, { scope: 'unhandled' });
    return { reason, failures };
}

function getErrors(owner: { errors?: () => ReadonlyArray<VitestRunError> }): ReadonlyArray<VitestRunError> {
    return owner.errors?.() ?? [];
}

function appendFailures(
    target: PathgradeRunFailure[],
    errors: ReadonlyArray<VitestRunError>,
    location: Pick<PathgradeRunFailure, 'scope' | 'file' | 'suite'>,
): void {
    for (const error of errors) {
        target.push({
            ...location,
            message: error.message,
            ...(error.name ? { name: error.name } : {}),
            ...(error.stack ? { stack: error.stack } : {}),
        });
    }
}

function getGroupName(testCase: TestCase): string {
    const modulePath = testCase.module.relativeModuleId;
    if (testCase.parent.type === 'suite') {
        return `${modulePath} > ${(testCase.parent as TestSuite).fullName}`;
    }
    return modulePath;
}

function toReportCaseInput(testCase: TestCase): ReportCaseInput {
    const pathgradeMeta = testCase.meta().pathgrade as PathgradeTestMeta[] | undefined;
    const result = testCase.result();
    const diagnostics = testCase.diagnostic();

    return {
        name: testCase.name,
        state: normalizeState(result.state),
        runnerDurationMs: diagnostics?.duration ?? 0,
        evaluations: pathgradeMeta?.map(entry => ({
            score: entry.score,
            trial: entry.trial,
            diagnostics: entry.diagnostics,
        })),
        diagnostics: undefined,
    };
}

function normalizeState(state: string): ReportCaseState {
    if (state === 'passed' || state === 'failed' || state === 'skipped' || state === 'pending') {
        return state;
    }
    return 'failed';
}
