import type { LogEntry } from '../types.js';
import type { ReactionFiredEntry, TurnDetail } from './types.js';
import { extractRuntimePolicyAuditEntries, type RuntimePolicyAuditEntry } from './runtime-policy.js';

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

export type DiagnosticsRuntimePolicyEntry = RuntimePolicyAuditEntry;

export interface DiagnosticsReport {
    turns: number;
    totalDurationMs: number;
    completionReason?: string;
    completionDetail?: string;
    score?: number;
    turnDetails: DiagnosticsTurnDetail[];
    reactionsFired: ReactionFiredEntry[];
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
        runtimePoliciesApplied: extractRuntimePolicyAuditEntries(input.log),
        recommendedTimeoutMs: recommendTimeoutMs(turnDetails),
        warnings,
        scorers: (input.scorers ?? []).map((scorer) => ({
            ...scorer,
            status: scorer.status ?? 'ok',
        })),
    };
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
