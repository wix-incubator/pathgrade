import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
    fmt,
    getPathgradeDir,
    printReportSummary,
    readSidecar,
    resolvePathgradeConfig,
    runWithAdapter,
} from '@wix/pathgrade/adapter-kit';
import { getJestLifecycleMetadata } from './lifecycle.js';
import { readJestMetadata, removeJestMetadata } from './metadata.js';
import { createJestAdapter } from './runner-adapter.js';
import type { JestAggregatedResult } from './results.js';

export default class PathgradeJestReporter {
    async onRunComplete(_contexts: unknown, results: JestAggregatedResult): Promise<void> {
        const cwd = process.cwd();
        const config = await resolvePathgradeConfig({ cwd });
        const mode = config.reporter ?? 'cli';
        const outputDir = getPathgradeDir(cwd);
        const metadataByCaseId = new Map([
            ...readJestMetadata(),
            ...getJestLifecycleMetadata(),
        ]);

        const exitCode = await runWithAdapter({
            adapter: createJestAdapter({
                results,
                metadataByCaseId,
            }),
            options: {
                cwd,
                discovery: { cwd },
                runnerArgs: [],
                env: process.env,
                artifactRoot: outputDir,
                reporterMode: mode,
                threshold: config.ci.threshold,
                writeEmptyReport: false,
                warn: warning => console.warn(warning),
                log: () => console.log(`\n  ${fmt.dim('Results written to')} ${outputDir}\n`),
                loadSelection: async () => (await readSidecar(cwd, msg => {
                    console.warn(`[pathgrade] ${msg}`);
                })) ?? undefined,
                printSummary: summaries => {
                    printReportSummary(summaries, {
                        forceVerbose: config.diagnostics
                            || process.env.PATHGRADE_DIAGNOSTICS === '1',
                    });
                },
                openBrowser: () => this.openBrowserViewer(),
                onThresholdFailure: ({ overallPassRate, threshold }) => {
                    process.exitCode = 1;
                    console.log(
                        `\n  ${fmt.fail('CI THRESHOLD FAILED')}  avg score ${fmt.bold(overallPassRate.toFixed(3))} < threshold ${fmt.bold(String(threshold))}\n`,
                    );
                },
            },
        });
        if (exitCode !== 0 && (process.exitCode === undefined || process.exitCode === 0)) {
            process.exitCode = exitCode;
        }
        removeJestMetadata();
    }

    private openBrowserViewer(): void {
        const viewerPath = path.resolve(import.meta.dirname, '..', '..', 'viewer.html');

        try {
            const openCmd = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32' ? 'start'
                    : 'xdg-open';
            execSync(`${openCmd} "${viewerPath}"`, { stdio: 'ignore' });
            console.log(`\n  ${fmt.dim('Opened viewer in browser')}\n`);
        } catch {
            console.log(`\n  ${fmt.dim('Open manually:')} ${viewerPath}\n`);
        }
    }
}
