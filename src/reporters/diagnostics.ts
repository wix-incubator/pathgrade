import type { DiagnosticsReport } from '../sdk/diagnostics.js';
export { buildDiagnosticsReport } from '../sdk/diagnostics.js';

export interface FormatDiagnosticsOptions {
    verbose?: boolean;
    currentTimeoutMs?: number;
}

export function formatDiagnosticsSummary(report: DiagnosticsReport): string {
    const turnsLabel = report.turns === 1 ? '1 turn' : `${report.turns} turns`;
    const durationLabel = `${(report.totalDurationMs / 1000).toFixed(1)}s`;
    const completion = report.completionReason ?? 'unknown';
    const scoreLabel = report.score == null ? 'n/a' : report.score.toFixed(2);
    return `${turnsLabel}  ${durationLabel}  ${completion}  score ${scoreLabel}`;
}

export function formatDiagnostics(report: DiagnosticsReport, opts: FormatDiagnosticsOptions = {}): string {
    if (opts.verbose === false) {
        return formatDiagnosticsSummary(report);
    }

    const lines: string[] = [
        'Unified Diagnostics',
        `Summary: ${formatDiagnosticsSummary(report)}`,
    ];

    if (report.completionDetail && report.completionReason === 'agent_crashed') {
        lines.push(`Agent crashed: ${report.completionDetail}`);
    } else if (
        report.completionDetail
        && (report.completionReason === 'error' || report.completionReason === 'timeout')
    ) {
        lines.push(`Error: ${report.completionDetail}`);
    }

    lines.push('', 'Turns:');

    for (const detail of report.turnDetails) {
        lines.push(
            `  Turn ${detail.turn}: ${(detail.durationMs / 1000).toFixed(1)}s, ${detail.outputLines} lines, ${detail.outputChars} chars, api retries: ${detail.apiRetries}`,
        );
    }

    if (report.reactionsFired.length > 0) {
        lines.push('', 'Reactions:');
        for (const reaction of report.reactionsFired) {
            lines.push(
                `  Turn ${reaction.turn}: reaction ${reaction.reactionIndex} ${reaction.pattern} -> ${reaction.reply}`,
            );
        }
    }

    if (report.runtimePoliciesApplied.length > 0) {
        lines.push('', 'Runtime policies:');
        for (const policy of report.runtimePoliciesApplied) {
            lines.push(`  ${policy.id}@${policy.version} applied on turns ${policy.turns.join(', ')}`);
        }
    }

    if (report.scorers.length > 0) {
        lines.push('', 'Scorers:');
        for (const scorer of report.scorers) {
            const detailSuffix = scorer.details ? ` ${scorer.details}` : '';
            lines.push(
                `  [${scorer.status}] ${scorer.name} (${scorer.type}) ${scorer.score.toFixed(2)}${detailSuffix}`,
            );
        }
    }

    if (report.warnings.length > 0) {
        lines.push('', 'Warnings:');
        for (const warning of report.warnings) {
            lines.push(`  ${warning}`);
        }
    }

    lines.push('', formatTimeoutRecommendation(report.recommendedTimeoutMs, opts.currentTimeoutMs));
    return lines.join('\n');
}

function formatTimeoutRecommendation(recommendedTimeoutMs: number, currentTimeoutMs?: number): string {
    const recommendedSeconds = Math.round(recommendedTimeoutMs / 1000);
    if (currentTimeoutMs == null) {
        return `Recommended timeout: ~${recommendedSeconds}s`;
    }
    if (currentTimeoutMs > recommendedTimeoutMs) {
        return `Timeout could be reduced to ~${recommendedSeconds}s`;
    }
    if (currentTimeoutMs < recommendedTimeoutMs) {
        return `Timeout should be increased to ~${recommendedSeconds}s`;
    }
    return `Timeout looks right at ~${recommendedSeconds}s`;
}
