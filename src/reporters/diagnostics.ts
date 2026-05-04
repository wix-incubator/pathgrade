import type { LogEntry } from '../types.js';
import type { ReactionFiredEntry, TurnDetail } from '../sdk/types.js';
import { extractRuntimePolicyAuditEntries, type RuntimePolicyAuditEntry } from '../sdk/runtime-policy.js';

export interface DiagnosticsScorer {
    name: string;
    type: string;
    score: number;
    weight: number;
    details?: string;
    status?: 'ok' | 'error' | 'skipped';
}

export interface DiagnosticsTurnDetail extends TurnDetail {
    apiRetries: number;
}

export interface DiagnosticsBlockedPromptEntry {
    turn: number;
    promptIndex: number;
    promptCount: number;
    sourceTool?: string;
    toolUseId?: string;
    rawAssistantMessage?: string;
    synthetic: boolean;
    sourceTurn?: number;
}

export type DiagnosticsRuntimePolicyEntry = RuntimePolicyAuditEntry;

export interface DiagnosticsReport {
    turns: number;
    totalDurationMs: number;
    completionReason?: string;
    completionDetail?: string;
    score?: number;
    turnDetails: DiagnosticsTurnDetail[];
    reactionsFired: ReactionFiredEntry[];
    blockedPrompts: DiagnosticsBlockedPromptEntry[];
    runtimePoliciesApplied: DiagnosticsRuntimePolicyEntry[];
    recommendedTimeoutMs: number;
    warnings: string[];
    scorers: Array<DiagnosticsScorer & { status: 'ok' | 'error' | 'skipped' }>;
}

export interface BuildDiagnosticsReportInput {
    completionReason?: string;
    completionDetail?: string;
    score?: number;
    turnDetails?: TurnDetail[];
    reactionsFired?: ReactionFiredEntry[];
    scorers?: DiagnosticsScorer[];
    log: LogEntry[];
}

export interface FormatDiagnosticsOptions {
    verbose?: boolean;
    currentTimeoutMs?: number;
}

export function buildDiagnosticsReport(input: BuildDiagnosticsReportInput): DiagnosticsReport {
    const baseTurnDetails = (input.turnDetails && input.turnDetails.length > 0)
        ? [...input.turnDetails]
        : deriveTurnDetailsFromLog(input.log);
    const retriesByTurn = countRetriesByTurn(input.log);
    const turnDetails = baseTurnDetails
        .sort((a, b) => a.turn - b.turn)
        .map((detail) => ({
            ...detail,
            apiRetries: retriesByTurn.get(detail.turn) ?? 0,
        }));

    const warnings = turnDetails
        .filter((detail) => detail.outputLines > 500)
        .map((detail) => `Turn ${detail.turn}: output exceeded 500 lines (${detail.outputLines} lines)`);

    return {
        turns: turnDetails.length,
        totalDurationMs: turnDetails.reduce((sum, detail) => sum + detail.durationMs, 0),
        completionReason: input.completionReason,
        completionDetail: input.completionDetail,
        score: input.score,
        turnDetails,
        reactionsFired: input.reactionsFired ?? [],
        blockedPrompts: extractBlockedPromptEntries(input.log),
        runtimePoliciesApplied: extractRuntimePolicyAuditEntries(input.log),
        recommendedTimeoutMs: recommendTimeoutMs(turnDetails),
        warnings,
        scorers: (input.scorers ?? []).map((scorer) => ({
            ...scorer,
            status: scorer.status ?? 'ok',
        })),
    };
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

    if (report.blockedPrompts.length > 0) {
        lines.push('', 'Blocked prompts:');
        for (const blockedPrompt of report.blockedPrompts) {
            const sourceTool = blockedPrompt.sourceTool ?? 'unknown tool';
            const promptLabel = `prompt ${blockedPrompt.promptIndex + 1}/${blockedPrompt.promptCount}`;
            const toolUseSuffix = blockedPrompt.toolUseId ? ` (${blockedPrompt.toolUseId})` : '';
            if (blockedPrompt.synthetic) {
                lines.push(
                    `  Replay from turn ${blockedPrompt.sourceTurn ?? blockedPrompt.turn}: ${sourceTool} ${promptLabel}${toolUseSuffix}`,
                );
            } else {
                lines.push(
                    `  Turn ${blockedPrompt.turn}: visible turn synthesized from ${sourceTool} ${promptLabel}${toolUseSuffix}`,
                );
                if (blockedPrompt.rawAssistantMessage) {
                    lines.push(`    raw completion: ${blockedPrompt.rawAssistantMessage}`);
                }
            }
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

function deriveTurnDetailsFromLog(log: LogEntry[]): TurnDetail[] {
    return log
        .filter((entry): entry is LogEntry & Required<Pick<LogEntry, 'turn_number' | 'duration_ms' | 'output_lines' | 'output_chars'>> =>
            entry.type === 'agent_result'
            && entry.synthetic_blocked_prompt !== true
            && typeof entry.turn_number === 'number'
            && typeof entry.duration_ms === 'number'
            && typeof entry.output_lines === 'number'
            && typeof entry.output_chars === 'number')
        .map((entry) => ({
            turn: entry.turn_number,
            durationMs: entry.duration_ms,
            outputLines: entry.output_lines,
            outputChars: entry.output_chars,
        }));
}

function countRetriesByTurn(log: LogEntry[]): Map<number, number> {
    const retriesByTurn = new Map<number, number>();
    let pendingRetries = 0;

    for (const entry of log) {
        if (isRetryEntry(entry)) {
            pendingRetries++;
            continue;
        }

        if (entry.type === 'agent_result' && typeof entry.turn_number === 'number') {
            if (pendingRetries > 0) {
                retriesByTurn.set(entry.turn_number, (retriesByTurn.get(entry.turn_number) ?? 0) + pendingRetries);
                pendingRetries = 0;
            }
            if (!retriesByTurn.has(entry.turn_number)) {
                retriesByTurn.set(entry.turn_number, 0);
            }
        }
    }

    return retriesByTurn;
}

function extractBlockedPromptEntries(log: LogEntry[]): DiagnosticsBlockedPromptEntry[] {
    return log
        .filter((entry) => entry.type === 'agent_result' && entry.assistant_message_source === 'blocked_prompt')
        .map((entry) => ({
            turn: entry.turn_number ?? entry.blocked_prompt_source_turn ?? 0,
            promptIndex: entry.blocked_prompt_index ?? 0,
            promptCount: entry.blocked_prompt_count ?? 1,
            sourceTool: entry.blocked_prompt_source_tool,
            toolUseId: entry.blocked_prompt_tool_use_id,
            rawAssistantMessage: entry.raw_assistant_message,
            synthetic: entry.synthetic_blocked_prompt === true,
            sourceTurn: entry.blocked_prompt_source_turn,
        }));
}

function isRetryEntry(entry: LogEntry): boolean {
    if (entry.type !== 'agent_result') return false;
    const text = `${entry.assistant_message ?? ''} ${entry.output ?? ''}`.toLowerCase();
    return text.includes('retry') || text.includes('api_retry');
}

function recommendTimeoutMs(turnDetails: TurnDetail[]): number {
    if (turnDetails.length <= 1) {
        return (turnDetails[0]?.durationMs ?? 0) + 30_000;
    }

    const totalDurationMs = turnDetails.reduce((sum, detail) => sum + detail.durationMs, 0);
    return Math.max(totalDurationMs + 200_000, 30_000);
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
