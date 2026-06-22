import * as path from 'path';
import { execSync } from 'child_process';
import type { Reporter, TestModule } from 'vitest/node';
import type { PathgradePluginOptions } from '../sdk/types.js';
import { fmt } from '../utils/cli.js';
import { getPathgradeDir } from '../reporters/results-path.js';
import { readSidecar } from '../affected/sidecar.js';
import { collectVitestReportGroups } from '../reporting/vitest-edge.js';
import { buildPathgradeReport } from '../reporting/core.js';
import { writePathgradeArtifacts } from '../reporting/artifacts.js';
import { printReportSummary } from '../reporters/report-summary.js';

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
        const groups = collectVitestReportGroups(testModules);
        const built = buildPathgradeReport({
            threshold: this.opts.ci?.threshold,
            groups,
        });

        for (const warning of built.warnings) {
            console.warn(`  [pathgrade] warning: ${warning}`);
        }

        if (built.report.groups.length === 0) return;

        const selection = await readSidecar(process.cwd(), msg => {
            console.warn(`[pathgrade] ${msg}`);
        });
        if (selection) {
            built.report.selection = selection;
        }

        const mode = this.opts.reporter ?? 'cli';

        if (mode === 'cli' || mode === 'browser') {
            printReportSummary(built.summaries, {
                forceVerbose: this.opts.diagnostics === true || process.env.PATHGRADE_DIAGNOSTICS === '1',
                currentTimeoutMs: this.opts.timeout != null ? this.opts.timeout * 1000 : undefined,
            });
        }

        const outputDir = getPathgradeDir(process.cwd());
        await writePathgradeArtifacts(outputDir, built);
        console.log(`\n  ${fmt.dim('Results written to')} ${outputDir}\n`);

        if (mode === 'browser') {
            this.openBrowserViewer();
        }

        if (this.opts.ci?.threshold != null) {
            const avg = built.report.overall_pass_rate;
            if (built.report.status === 'fail') {
                console.log(
                    `\n  ${fmt.fail('CI THRESHOLD FAILED')}  avg score ${fmt.bold(avg.toFixed(3))} < threshold ${fmt.bold(String(this.opts.ci.threshold))}\n`,
                );
                process.exitCode = 1;
            }
        }
    }

    private openBrowserViewer(): void {
        const viewerPath = path.resolve(import.meta.dirname, '..', 'viewer.html');

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
