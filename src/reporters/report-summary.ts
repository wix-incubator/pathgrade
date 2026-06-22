import { fmt } from '../utils/cli.js';
import type { ReportSummaryGroup } from '../reporting/types.js';
import { formatDiagnostics, formatDiagnosticsSummary } from './diagnostics.js';

export interface PrintReportSummaryOptions {
    forceVerbose?: boolean;
    currentTimeoutMs?: number;
}

export function printReportSummary(groups: ReportSummaryGroup[], opts: PrintReportSummaryOptions = {}): void {
    console.log(`\n${fmt.bold('── pathgrade summary ')}${fmt.dim('─'.repeat(40))}\n`);

    for (const group of groups) {
        const prColor = group.pass_rate >= 0.5 ? fmt.green : fmt.red;

        console.log(`  ${fmt.bold(group.task)}`);
        console.log(`    ${fmt.dim('pass rate'.padEnd(12))} ${prColor((group.pass_rate * 100).toFixed(1) + '%')}`);
        console.log(`    ${fmt.dim(`pass@${group.trial_count}`.padEnd(12))} ${(group.pass_at_k * 100).toFixed(1)}%`);
        console.log(`    ${fmt.dim(`pass^${group.trial_count}`.padEnd(12))} ${(group.pass_pow_k * 100).toFixed(1)}%`);
        console.log(`    ${fmt.dim('avg time'.padEnd(12))} ${(group.average_duration_ms / 1000).toFixed(1)}s`);
        console.log(`    ${fmt.dim('trials'.padEnd(12))} ${group.trial_count}`);
        console.log();

        for (const diagnostic of group.diagnostics) {
            const shouldPrintFull = opts.forceVerbose
                || diagnostic.state !== 'passed'
                || diagnostic.report.completionReason === 'timeout'
                || diagnostic.report.completionReason === 'agent_crashed';
            console.log(`    ${fmt.bold(diagnostic.caseName)}`);
            const formatted = shouldPrintFull
                ? formatDiagnostics(diagnostic.report, { verbose: true, currentTimeoutMs: opts.currentTimeoutMs })
                : formatDiagnosticsSummary(diagnostic.report);
            for (const line of formatted.split('\n')) {
                console.log(`      ${line}`);
            }
            console.log();
        }
    }
}
