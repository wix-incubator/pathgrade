import type { TestCase, TestModule, TestSuite } from 'vitest/node';
import { discoverPathgradeEvalFiles } from '../evals/discovery.js';
import { buildDiagnosticsReport } from '../sdk/diagnostics.js';
import type { PathgradeTestMeta } from '../sdk/types.js';
import type { ReportCaseInput, ReportCaseState, ReportGroupInput } from '../reporting/types.js';
import type {
    AdapterInvocationInput,
    AdapterRunHandle,
    RunnerAdapter,
} from './adapter.js';

export interface VitestAdapterOptions {
    testModules?: ReadonlyArray<TestModule>;
}

interface VitestRunNative {
    testModules: ReadonlyArray<TestModule>;
}

export function createVitestAdapter(options: VitestAdapterOptions = {}): RunnerAdapter {
    return {
        name: 'vitest',
        async discover(input) {
            const include = input.include ?? ['**/*.eval.ts'];
            const exclude = input.exclude ?? [];
            const files = discoverPathgradeEvalFiles({
                cwd: input.cwd,
                include,
                exclude,
            });

            return {
                units: files.map(file => ({
                    id: file,
                    displayName: file,
                    sourceRef: file,
                    native: { file },
                })),
            };
        },
        async invoke(input: AdapterInvocationInput): Promise<AdapterRunHandle> {
            return {
                adapterName: this.name,
                status: input.signal?.aborted ? 'cancelled' : 'completed',
                exitCode: input.signal?.aborted ? 1 : 0,
                native: {
                    testModules: options.testModules ?? [],
                } satisfies VitestRunNative,
            };
        },
        async collectReportGroups(run) {
            return collectVitestReportGroups(readVitestRunNative(run).testModules);
        },
    };
}

export function collectVitestReportGroups(testModules: ReadonlyArray<TestModule>): ReportGroupInput[] {
    const groupMap = new Map<string, ReportCaseInput[]>();

    for (const mod of testModules) {
        for (const testCase of mod.children.allTests()) {
            const groupName = getGroupName(testCase);
            const entry = toReportCaseInput(testCase, groupName);
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

function readVitestRunNative(run: AdapterRunHandle): VitestRunNative {
    if (isVitestRunNative(run.native)) return run.native;
    return { testModules: [] };
}

function isVitestRunNative(native: unknown): native is VitestRunNative {
    return typeof native === 'object'
        && native !== null
        && Array.isArray((native as { testModules?: unknown }).testModules);
}

function getGroupName(testCase: TestCase): string {
    const modulePath = testCase.module.relativeModuleId;
    if (testCase.parent.type === 'suite') {
        return `${modulePath} > ${(testCase.parent as TestSuite).fullName}`;
    }
    return modulePath;
}

function toReportCaseInput(testCase: TestCase, groupName: string): ReportCaseInput {
    const pathgradeMeta = testCase.meta().pathgrade as PathgradeTestMeta[] | undefined;
    const result = testCase.result();
    const diagnostics = testCase.diagnostic();
    const normalized = normalizeState(result.state);
    const filePath = testCase.module.relativeModuleId;
    const runnerCaseId = typeof testCase.id === 'string' ? testCase.id : undefined;

    return {
        ...(runnerCaseId ? { caseId: runnerCaseId, runnerCaseId } : {}),
        name: testCase.name,
        state: normalized.state,
        runnerDurationMs: diagnostics?.duration ?? 0,
        sourceRef: filePath,
        filePath,
        groupName,
        evaluations: pathgradeMeta?.map(entry => ({
            score: entry.score,
            trial: entry.trial,
            diagnostics: entry.diagnostics,
        })),
        diagnostics: normalized.diagnostics,
    };
}

function normalizeState(state: string): {
    state: ReportCaseState;
    diagnostics?: ReportCaseInput['diagnostics'];
} {
    if (state === 'passed' || state === 'failed' || state === 'skipped' || state === 'pending') {
        return { state };
    }

    return {
        state: 'failed',
        diagnostics: buildDiagnosticsReport({
            completionReason: state,
            score: 0,
            log: [],
        }),
    };
}
