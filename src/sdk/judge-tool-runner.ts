import type { ToolCapableLLMPort } from '../utils/llm-types.js';
import type { JudgeScorer, ScorerContext, ScorerResultEntry, TokenUsage } from './types.js';
import {
    runJudgeSession,
    type JudgeErrorCode,
    type JudgeToolCallRecord,
    type SessionOutcome,
    type ToolExecutor,
} from './judge-tool-session.js';

export type { JudgeErrorCode, JudgeToolCallRecord };

export interface RunJudgeWithToolsResult {
    entry: ScorerResultEntry;
    rounds: number;
    toolCalls: JudgeToolCallRecord[];
    tokenUsage: TokenUsage;
    wallTimeMs: number;
}

export interface RunJudgeWithToolsOptions {
    maxRounds?: number;
    /** Override the per-tool timeout (ms). Default 10_000. */
    toolTimeoutMs?: number;
    /** Override tool execution; used by tests that need to simulate slow or buggy tools. */
    toolExecutor?: ToolExecutor;
}

export async function runJudgeWithTools(
    scorer: JudgeScorer,
    ctx: ScorerContext,
    llm: ToolCapableLLMPort,
    opts: RunJudgeWithToolsOptions = {},
): Promise<RunJudgeWithToolsResult> {
    const startedAt = Date.now();
    const retries = getRetryCount(scorer.retry);
    let last!: SessionOutcome;
    for (let attempt = 0; attempt <= retries; attempt++) {
        last = await runJudgeSession({ scorer, ctx, llm }, {
            maxRounds: opts.maxRounds,
            toolTimeoutMs: opts.toolTimeoutMs,
            toolExecutor: opts.toolExecutor,
        });
        if (last.code !== 'llm_refused' && last.code !== 'invalid_score') break;
    }
    return {
        entry: toEntry(scorer, last),
        rounds: last.rounds,
        toolCalls: last.toolCalls,
        tokenUsage: last.tokenUsage,
        wallTimeMs: Date.now() - startedAt,
    };
}

function getRetryCount(retry: JudgeScorer['retry']): number {
    if (retry === true) return 1;
    if (typeof retry === 'number' && Number.isFinite(retry)) {
        return Math.max(0, Math.floor(retry));
    }
    return 0;
}

function toEntry(scorer: JudgeScorer, outcome: SessionOutcome): ScorerResultEntry {
    if (outcome.code === null) {
        return {
            name: scorer.name,
            type: 'judge',
            score: outcome.score,
            weight: scorer.weight,
            details: outcome.details,
            status: 'ok',
        };
    }
    return {
        name: scorer.name,
        type: 'judge',
        score: 0,
        weight: scorer.weight,
        details: outcome.details,
        status: 'error',
        errorCode: outcome.code,
    };
}
