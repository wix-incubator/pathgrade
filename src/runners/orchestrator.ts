import { buildPathgradeReport } from '../reporting/core.js';
import { writePathgradeArtifacts } from '../reporting/artifacts.js';
import { projectNormalizedRunSnapshotToReportInput } from './report-projection.js';
import type { PathgradeSelectionReport } from '../types.js';
import type { ReportSummaryGroup } from '../reporting/types.js';
import type { StandaloneRunProvenance } from '../standalone/provenance.js';
import type {
    AdapterDiscoveryInput,
    AdapterLifecycleHooks,
    AdapterRunStatus,
    RunnerAdapter,
} from './adapter.js';

export type AdapterReporterMode = 'cli' | 'browser' | 'json';

export interface PathgradeRunOptions {
    cwd: string;
    discovery: AdapterDiscoveryInput;
    runnerArgs: string[];
    env: NodeJS.ProcessEnv;
    artifactRoot: string;
    reporterMode?: AdapterReporterMode;
    threshold?: number;
    selection?: PathgradeSelectionReport;
    provenance?: StandaloneRunProvenance;
    lifecycle?: AdapterLifecycleHooks;
    signal?: AbortSignal;
    printSummary?: (summaries: ReportSummaryGroup[]) => void;
    openBrowser?: () => void | Promise<void>;
    loadSelection?: () => Promise<PathgradeSelectionReport | undefined>;
    onThresholdFailure?: (input: { overallPassRate: number; threshold: number }) => void;
    writeEmptyReport?: boolean;
    log?: (message: string) => void;
    warn?: (message: string) => void;
}

export async function runWithAdapter(input: {
    adapter: RunnerAdapter;
    options: PathgradeRunOptions;
}): Promise<number> {
    const { adapter, options } = input;
    const lifecycle = options.lifecycle ?? createNoopLifecycleHooks();

    try {
        const selection = options.selection ?? options.discovery.selection;
        const discovered = await adapter.discover({
            ...options.discovery,
            ...(selection ? { selection } : {}),
        });
        const run = await adapter.invoke({
            discovered,
            argv: options.runnerArgs,
            env: options.env,
            lifecycle,
            signal: options.signal,
        });
        const runExitCode = normalizeRunExitCode(run.status, run.exitCode);
        const reportInput = projectNormalizedRunSnapshotToReportInput(
            await adapter.collectNormalizedRunSnapshot(run),
            { selection },
        );
        let built = buildPathgradeReport({
            threshold: options.threshold,
            provenance: options.provenance,
            ...reportInput,
        });

        for (const warning of built.warnings) {
            options.warn?.(`  [pathgrade] warning: ${warning}`);
        }

        if (built.report.groups.length === 0 && options.writeEmptyReport === false) {
            return runExitCode;
        }

        const loadedSelection = await options.loadSelection?.();
        if (loadedSelection) {
            built = buildPathgradeReport({
                threshold: options.threshold,
                selection: loadedSelection,
                provenance: options.provenance,
                groups: reportInput.groups,
            });
        }

        const mode = options.reporterMode ?? 'cli';
        if (mode === 'cli' || mode === 'browser') {
            options.printSummary?.(built.summaries);
        }

        await writePathgradeArtifacts(options.artifactRoot, built);
        options.log?.(`results:${options.artifactRoot}`);

        if (mode === 'browser') {
            await options.openBrowser?.();
        }

        if (options.threshold != null && built.report.status === 'fail') {
            options.onThresholdFailure?.({
                overallPassRate: built.report.overall_pass_rate,
                threshold: options.threshold,
            });
            return runExitCode === 0 ? 1 : runExitCode;
        }

        return runExitCode;
    } finally {
        await lifecycle.cleanupRun();
    }
}

function normalizeRunExitCode(status: AdapterRunStatus, exitCode: number): number {
    if (status === 'completed') return exitCode;
    return exitCode === 0 ? 1 : exitCode;
}

function createNoopLifecycleHooks(): AdapterLifecycleHooks {
    return {
        onResult: () => undefined,
        withCaseContext: (_context, run) => run(),
        flushCase: async () => [],
        cleanupRun: async () => undefined,
    };
}
