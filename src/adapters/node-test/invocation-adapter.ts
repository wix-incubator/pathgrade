import { readSidecar } from '../../affected/sidecar.js';
import type { ResolvedPathgradeConfig } from '../../config/pathgrade.js';
import { getPathgradeDir } from '../../reporters/results-path.js';
import { printReportSummary } from '../../reporters/report-summary.js';
import type { RunnerInvocationAdapter } from '../../runners/invocation.js';
import { runWithAdapter } from '../../runners/orchestrator.js';
import { createNodeTestAdapter } from './runner-adapter.js';

export function createNodeTestInvocationAdapter(input: {
    config: ResolvedPathgradeConfig;
}): RunnerInvocationAdapter {
    return {
        name: 'node-test',
        async run(runInput) {
            const selection = await readSidecar(runInput.cwd, msg => {
                process.stderr.write(`[pathgrade] ${msg}\n`);
            }) ?? undefined;
            const include = runInput.selectedFiles && runInput.selectedFiles.length > 0
                ? runInput.selectedFiles
                : input.config.evals.include;

            return await runWithAdapter({
                adapter: createNodeTestAdapter(),
                options: {
                    cwd: runInput.cwd,
                    discovery: {
                        cwd: runInput.cwd,
                        include,
                        exclude: runInput.selectedFiles ? [] : input.config.evals.exclude,
                    },
                    runnerArgs: runInput.runnerArgs,
                    env: runInput.env,
                    artifactRoot: getPathgradeDir(runInput.cwd),
                    reporterMode: input.config.reporter ?? 'cli',
                    threshold: input.config.ci.threshold,
                    selection,
                    printSummary: summaries => {
                        printReportSummary(summaries, {
                            forceVerbose: input.config.diagnostics
                                || runInput.env.PATHGRADE_DIAGNOSTICS === '1',
                        });
                    },
                    log: () => {
                        process.stdout.write(`\n  Results written to ${getPathgradeDir(runInput.cwd)}\n\n`);
                    },
                    onThresholdFailure: ({ overallPassRate, threshold }) => {
                        process.stdout.write(
                            `\n  CI THRESHOLD FAILED  avg score ${overallPassRate.toFixed(3)} < threshold ${threshold}\n\n`,
                        );
                    },
                },
            });
        },
    };
}
