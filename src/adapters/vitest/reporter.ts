import * as path from 'path';
import { execSync } from 'child_process';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
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
import { createStandaloneUiSink, type StandaloneUiSink } from '../../standalone/ui/protocol.js';
import type { StandaloneCaseState } from '../../standalone/ui/events.js';

/**
 * Custom vitest reporter that layers pathgrade aggregate statistics
 * on top of vitest's default output.
 */
export class PathgradeReporter implements Reporter {
    private opts: PathgradePluginOptions;
    private readonly ui: StandaloneUiSink;
    private readonly startedAt = Date.now();
    private fileCount = 0;

    constructor(opts?: PathgradePluginOptions) {
        this.opts = opts ?? {};
        this.ui = createStandaloneUiSink(
            isStandaloneMode(process.env) && (this.opts.reporter ?? 'cli') !== 'json',
        );
    }

    onTestRunStart(specifications: ReadonlyArray<{ moduleId?: string }>): void {
        const files = specifications.map((specification, index) => ({
            id: specification.moduleId ?? String(index),
            name: specification.moduleId ?? `eval ${index + 1}`,
        }));
        this.fileCount = files.length;
        this.ui.emit({ v: 1, type: 'run_start', files, startedAt: this.startedAt });
    }

    onTestCaseReady(testCase: TestCase): void {
        this.ui.emit({
            v: 1,
            type: 'case_start',
            id: testCase.id,
            file: testCase.module.relativeModuleId,
            name: testCase.name,
            startedAt: Date.now(),
        });
    }

    onTestCaseResult(testCase: TestCase): void {
        const evaluations = testCase.meta().pathgrade as Array<{ score: number }> | undefined;
        const score = evaluations?.at(-1)?.score;
        const state = normalizeUiState(testCase.result().state);
        this.ui.emit({
            v: 1,
            type: 'case_finish',
            id: testCase.id,
            file: testCase.module.relativeModuleId,
            name: testCase.name,
            state,
            durationMs: testCase.diagnostic()?.duration ?? 0,
            ...(score === undefined ? {} : { score }),
        });
    }

    async onTestRunEnd(testModules: ReadonlyArray<TestModule>): Promise<void> {
        const cwd = process.cwd();
        const config = await resolvePathgradeConfig({
            cwd,
            standalone: isStandaloneMode(process.env),
        });
        const mode = this.opts.reporter ?? config.reporter ?? 'cli';
        const standalone = isStandaloneMode(process.env);
        const outputDir = getPathgradeDir(cwd);
        const adapter = createVitestAdapter({ testModules });
        const provenance = standalone
            ? readStandaloneRunProvenance(process.env)
            : undefined;

        let exitCode: number;
        try {
            exitCode = await runWithAdapter({
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
                log: standalone
                    ? undefined
                    : () => console.log(`\n  ${fmt.dim('Results written to')} ${outputDir}\n`),
                loadSelection: async () => (await readSidecar(cwd, msg => {
                    console.warn(`[pathgrade] ${msg}`);
                })) ?? undefined,
                printSummary: summaries => {
                    const diagnostics = this.opts.diagnostics === true
                        || config.diagnostics
                        || process.env.PATHGRADE_DIAGNOSTICS === '1';
                    if (standalone && !diagnostics) return;
                    printReportSummary(summaries, {
                        forceVerbose: diagnostics,
                        currentTimeoutMs: this.opts.timeout != null ? this.opts.timeout * 1000 : undefined,
                    });
                },
                openBrowser: () => this.openBrowserViewer(),
                onThresholdFailure: ({ overallPassRate, threshold }) => {
                    const avg = overallPassRate;
                    const configuredThreshold = this.opts.ci?.threshold ?? threshold;
                    process.exitCode = 1;
                    if (!standalone || mode === 'json') {
                        console.log(
                            `\n  ${fmt.fail('CI THRESHOLD FAILED')}  avg score ${fmt.bold(avg.toFixed(3))} < threshold ${fmt.bold(String(configuredThreshold))}\n`,
                        );
                    }
                },
                onArtifactsWritten: ({ built, artifacts }) => {
                    const states = testModules.flatMap(module => [...module.children.allTests()])
                        .map(testCase => normalizeUiState(testCase.result().state));
                    this.ui.emit({
                        v: 1,
                        type: 'run_finish',
                        status: built.report.status,
                        fileCount: this.fileCount || testModules.length,
                        passed: states.filter(state => state === 'passed').length,
                        failed: states.filter(state => state === 'failed').length,
                        skipped: states.filter(state => state === 'skipped' || state === 'pending').length,
                        durationMs: Date.now() - this.startedAt,
                        overallScore: built.report.overall_pass_rate,
                        ...(built.report.threshold === undefined ? {} : { threshold: built.report.threshold }),
                        resultsPath: path.relative(cwd, artifacts.resultsPath),
                    });
                },
            },
            });
        } catch (error) {
            this.ui.emit({ v: 1, type: 'run_error' });
            throw error;
        }
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

function normalizeUiState(state: string): StandaloneCaseState {
    if (state === 'passed' || state === 'failed' || state === 'skipped' || state === 'pending') {
        return state;
    }
    return 'failed';
}
