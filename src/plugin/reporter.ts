import * as path from 'path';
import { execSync } from 'child_process';
import type { Reporter, TestModule, TestCase, TestSuite } from 'vitest/node';
import type { PathgradePluginOptions } from '../sdk/types.js';
import type { PathgradeTestMeta } from '../sdk/types.js';
import type { EvalReport, PathgradeGroupReport, PathgradeReport, StrippedTrialResult, TrialResult } from '../types.js';
import type { DiagnosticsReport } from '../reporters/diagnostics.js';
import { extractSkillsFromLog } from '../tool-events.js';
import { fmt, header } from '../utils/cli.js';
import { getPathgradeDir } from '../reporters/results-path.js';
import fs from 'fs-extra';
import { formatDiagnostics, formatDiagnosticsSummary } from '../reporters/diagnostics.js';
import { readSidecar } from '../affected/sidecar.js';

interface GroupedResult {
    groupName: string;
    tests: TestEntry[];
}

interface TestEntry {
    name: string;
    score: number;
    durationMs: number;
    state: 'passed' | 'failed' | 'skipped' | 'pending';
    trial?: TrialResult;
    diagnostics?: DiagnosticsReport;
}

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
        const groups = this.collectGroups(testModules);

        if (groups.length === 0) return;

        const mode = this.opts.reporter ?? 'cli';

        if (mode === 'cli' || mode === 'browser') {
            this.printCliSummary(groups);
        }

        await this.writeJsonResults(groups);

        if (mode === 'browser') {
            this.openBrowserViewer(groups);
        }

        // CI threshold check
        if (this.opts.ci?.threshold != null) {
            const allScores = groups.flatMap((g) => g.tests.map((t) => t.score));
            if (allScores.length > 0) {
                const avg = allScores.reduce((a, b) => a + b, 0) / allScores.length;
                if (avg < this.opts.ci.threshold) {
                    console.log(
                        `\n  ${fmt.fail('CI THRESHOLD FAILED')}  avg score ${fmt.bold(avg.toFixed(3))} < threshold ${fmt.bold(String(this.opts.ci.threshold))}\n`,
                    );
                    process.exitCode = 1;
                }
            }
        }
    }

    private collectGroups(testModules: ReadonlyArray<TestModule>): GroupedResult[] {
        const groupMap = new Map<string, TestEntry[]>();

        for (const mod of testModules) {
            for (const testCase of mod.children.allTests()) {
                const groupKey = this.getGroupKey(testCase);
                const entry = this.toTestEntry(testCase);

                if (!groupMap.has(groupKey)) {
                    groupMap.set(groupKey, []);
                }
                groupMap.get(groupKey)!.push(entry);
            }
        }

        return Array.from(groupMap.entries()).map(([groupName, tests]) => ({
            groupName,
            tests,
        }));
    }

    /**
     * Group key is the parent suite's full name (file + describe hierarchy).
     * Tests without a describe wrapper are grouped by module path.
     */
    private getGroupKey(testCase: TestCase): string {
        const parent = testCase.parent;
        const modulePath = testCase.module.relativeModuleId;

        if (parent.type === 'suite') {
            return `${modulePath} > ${(parent as TestSuite).fullName}`;
        }
        return modulePath;
    }

    private toTestEntry(testCase: TestCase): TestEntry {
        const meta = testCase.meta();
        const pathgradeMeta: PathgradeTestMeta[] | undefined = meta.pathgrade;
        const diag = testCase.diagnostic();
        const result = testCase.result();

        let score = 0;
        let trial: TrialResult | undefined;
        let diagnostics: DiagnosticsReport | undefined;

        if (pathgradeMeta === undefined) {
            // Test didn't use pathgrade — infer from test pass/fail
            score = result.state === 'passed' ? 1 : 0;
        } else if (pathgradeMeta.length === 0) {
            // Anomaly: pathgrade was set up but evaluate() was never called
            console.warn(`  [pathgrade] warning: empty results for "${testCase.name}" — evaluate() may not have been called`);
            score = result.state === 'passed' ? 1 : 0;
        } else {
            // Use the last eval result's score
            score = pathgradeMeta[pathgradeMeta.length - 1].score;
            trial = pathgradeMeta[pathgradeMeta.length - 1].trial;
            diagnostics = pathgradeMeta[pathgradeMeta.length - 1].diagnostics;
        }

        return {
            name: testCase.name,
            score,
            durationMs: diag?.duration ?? 0,
            state: result.state === 'pending' ? 'pending' : result.state,
            trial,
            diagnostics,
        };
    }

    private printCliSummary(groups: GroupedResult[]): void {
        console.log(`\n${fmt.bold('── pathgrade summary ')}${fmt.dim('─'.repeat(40))}\n`);
        const forceVerbose = this.opts.diagnostics === true || process.env.PATHGRADE_DIAGNOSTICS === '1';
        const currentTimeoutMs = this.opts.timeout != null ? this.opts.timeout * 1000 : undefined;

        for (const group of groups) {
            const k = group.tests.length;
            const passRate = this.computePassRate(group.tests);
            const passAtK = this.computePassAtK(passRate, k);
            const passPowK = this.computePassPowK(passRate, k);
            const avgDuration = this.computeAvgDuration(group.tests);

            const prColor = passRate >= 0.5 ? fmt.green : fmt.red;

            console.log(`  ${fmt.bold(group.groupName)}`);
            console.log(`    ${fmt.dim('pass rate'.padEnd(12))} ${prColor((passRate * 100).toFixed(1) + '%')}`);
            console.log(`    ${fmt.dim(`pass@${k}`.padEnd(12))} ${(passAtK * 100).toFixed(1)}%`);
            console.log(`    ${fmt.dim(`pass^${k}`.padEnd(12))} ${(passPowK * 100).toFixed(1)}%`);
            console.log(`    ${fmt.dim('avg time'.padEnd(12))} ${(avgDuration / 1000).toFixed(1)}s`);
            console.log(`    ${fmt.dim('trials'.padEnd(12))} ${k}`);
            console.log();

            for (const test of group.tests) {
                if (!test.diagnostics) continue;
                const shouldPrintFull = forceVerbose || test.state !== 'passed' || test.diagnostics.completionReason === 'timeout' || test.diagnostics.completionReason === 'agent_crashed';
                console.log(`    ${fmt.bold(test.name)}`);
                const formatted = shouldPrintFull
                    ? formatDiagnostics(test.diagnostics, { verbose: true, currentTimeoutMs })
                    : formatDiagnosticsSummary(test.diagnostics);
                for (const line of formatted.split('\n')) {
                    console.log(`      ${line}`);
                }
                console.log();
            }
        }
    }

    private async writeJsonResults(groups: GroupedResult[]): Promise<void> {
        const outputDir = getPathgradeDir(process.cwd());
        const tracesDir = path.join(outputDir, 'traces');
        await fs.ensureDir(tracesDir);

        // Auto-create .gitignore if it doesn't exist
        const gitignorePath = path.join(outputDir, '.gitignore');
        if (!(await fs.pathExists(gitignorePath))) {
            await fs.writeFile(gitignorePath, '*\n');
        }

        const allScores = groups.flatMap((g) => g.tests.map((t) => t.score));
        const overallPassRate = allScores.length > 0
            ? allScores.reduce((a, b) => a + b, 0) / allScores.length
            : 0;

        const threshold = this.opts.ci?.threshold;
        const status: 'pass' | 'fail' = threshold != null
            ? (overallPassRate >= threshold ? 'pass' : 'fail')
            : (groups.every(g => g.tests.every(t => t.state === 'passed')) ? 'pass' : 'fail');

        const consolidatedGroups: PathgradeGroupReport[] = [];

        for (const group of groups) {
            const report = this.buildEvalReport(group);
            const slug = this.slug(group.groupName);
            const traceFile = `traces/${slug}.json`;

            // Write full trace data (with session_log and conversation)
            await fs.writeJson(path.join(outputDir, traceFile), report.trials, { spaces: 2 });

            // Strip session_log and conversation from trials in consolidated report
            const strippedTrials: StrippedTrialResult[] = report.trials.map(t => {
                const { session_log, conversation, ...rest } = t;
                return rest;
            });

            const { trials: _omitted, ...rest } = report;
            consolidatedGroups.push({
                ...rest,
                trials: strippedTrials,
                trace_file: traceFile,
            });
        }

        // Merge selection metadata from the CLI-written sidecar, if any.
        // Missing sidecar → plain run; malformed → warn and proceed without it.
        const selection = await readSidecar(process.cwd(), msg => {
            console.warn(`[pathgrade] ${msg}`);
        });

        const consolidated: PathgradeReport = {
            version: 1,
            timestamp: new Date().toISOString(),
            ...(threshold != null ? { threshold } : {}),
            overall_pass_rate: overallPassRate,
            status,
            groups: consolidatedGroups,
            ...(selection ? { selection } : {}),
        };

        await fs.writeJson(path.join(outputDir, 'results.json'), consolidated, { spaces: 2 });
        console.log(`\n  ${fmt.dim('Results written to')} ${outputDir}\n`);
    }

    private buildEvalReport(group: GroupedResult): EvalReport {
        const trials = group.tests.map((test, index) => this.toTrialResult(test, index));
        const passRate = this.computePassRate(group.tests);

        // Aggregate skills_used across all trials (deduplicated)
        const allSkills = new Set<string>();
        for (const trial of trials) {
            for (const skill of trial.skills_used ?? []) {
                allSkills.add(skill);
            }
        }

        return {
            task: group.groupName,
            pass_rate: passRate,
            pass_at_k: this.computePassAtK(passRate, trials.length),
            pass_pow_k: this.computePassPowK(passRate, trials.length),
            trials,
            skills_used: [...allSkills],
        };
    }

    private toTrialResult(test: TestEntry, index: number): TrialResult {
        const base = test.trial ?? {
            trial_id: index + 1,
            reward: test.score,
            scorer_results: [],
            duration_ms: test.durationMs,
            n_commands: 0,
            input_tokens: 0,
            output_tokens: 0,
            session_log: [],
        };

        // Extract skills_used from session_log tool events if not already present
        const skills = base.skills_used ?? extractSkillsFromLog(base.session_log);

        return {
            ...base,
            trial_id: index + 1,
            name: test.name,
            duration_ms: base.duration_ms || test.durationMs,
            diagnostics: test.diagnostics ?? base.diagnostics,
            ...(skills.length > 0 ? { skills_used: skills } : {}),
        };
    }


    private slug(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'report';
    }

    private openBrowserViewer(_groups: GroupedResult[]): void {
        // Write results JSON first, then open the viewer
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

    private computePassRate(tests: TestEntry[]): number {
        if (tests.length === 0) return 0;
        const passed = tests.filter((t) => t.state === 'passed').length;
        return passed / tests.length;
    }

    /**
     * pass@k = 1 - (1 - p)^k
     * Probability of at least 1 success in k trials.
     */
    private computePassAtK(passRate: number, k: number): number {
        return 1 - Math.pow(1 - passRate, k);
    }

    /**
     * pass^k = p^k
     * Probability of all k trials succeeding.
     */
    private computePassPowK(passRate: number, k: number): number {
        return Math.pow(passRate, k);
    }

    private computeAvgDuration(tests: TestEntry[]): number {
        if (tests.length === 0) return 0;
        return tests.reduce((sum, t) => sum + t.durationMs, 0) / tests.length;
    }
}
