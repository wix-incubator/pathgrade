import * as path from 'path';
import { execSync } from 'child_process';
import type { Reporter, TestModule } from 'vitest/node';
import type { PathgradePluginOptions } from '../../sdk/types.js';
import { fmt } from '../../utils/cli.js';
import { getPathgradeDir } from '../../reporters/results-path.js';
import { readSidecar } from '../../affected/sidecar.js';
import { printReportSummary } from '../../reporters/report-summary.js';
import { createVitestAdapter } from '../../runners/vitest-adapter.js';
import { runWithAdapter } from '../../runners/orchestrator.js';
import { resolvePathgradeConfig } from '../../config/pathgrade.js';
import { isStandaloneMode } from '../../standalone/mode.js';
import { readStandaloneRunProvenance } from '../../standalone/provenance.js';

/**
 * Custom vitest reporter that layers pathgrade aggregate statistics
 * on top of vitest's default output.
 */
export class PathgradeReporter implements Reporter {
    private opts: PathgradePluginOptions;

    constructor(opts?: PathgradePluginOptions) {
        this.opts = opts ?? {};
    }

    async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
        const cwd = process.cwd();
        const config = await resolvePathgradeConfig({
            cwd,
            standalone: isStandaloneMode(process.env),
        });
        const mode = this.opts.reporter ?? config.reporter ?? 'cli';
        const outputDir = getPathgradeDir(cwd);
        const adapter = createVitestAdapter({ testModules });
        const provenance = isStandaloneMode(process.env)
            ? readStandaloneRunProvenance(process.env)
            : undefined;

        const exitCode = await runWithAdapter({
            adapter,
            options: {
                cwd,
                discovery: { cwd },
                runnerArgs: [],
                env: process.env,
                artifactRoot: outputDir,
                reporterMode: mode,
                threshold: this.opts.ci?.threshold ?? config.ci.threshold,
                provenance,
                writeEmptyReport: false,
                warn: warning => console.warn(warning),
                log: () => console.log(`\n  ${fmt.dim('Results written to')} ${outputDir}\n`),
                loadSelection: async () => (await readSidecar(cwd, msg => {
                    console.warn(`[pathgrade] ${msg}`);
                })) ?? undefined,
                printSummary: summaries => {
                    printReportSummary(summaries, {
                        forceVerbose: this.opts.diagnostics === true
                            || config.diagnostics
                            || process.env.PATHGRADE_DIAGNOSTICS === '1',
                        currentTimeoutMs: this.opts.timeout != null ? this.opts.timeout * 1000 : undefined,
                    });
                },
                openBrowser: () => this.openBrowserViewer(),
                onThresholdFailure: ({ overallPassRate, threshold }) => {
                    const avg = overallPassRate;
                    const configuredThreshold = this.opts.ci?.threshold ?? threshold;
                    process.exitCode = 1;
                    console.log(
                        `\n  ${fmt.fail('CI THRESHOLD FAILED')}  avg score ${fmt.bold(avg.toFixed(3))} < threshold ${fmt.bold(String(configuredThreshold))}\n`,
                    );
                },
            },
        });
        if (exitCode !== 0 && (process.exitCode === undefined || process.exitCode === 0)) {
            process.exitCode = exitCode;
        }
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
