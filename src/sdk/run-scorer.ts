import type { LLMPort, ToolCapableLLMPort } from '../utils/llm-types.js';
import type {
    CheckScorer,
    JudgeScorer,
    Scorer,
    ScoreScorer,
    ScorerContext,
    ScorerResultEntry,
    ToolUsageScorer,
} from './types.js';
import { runJudgePipeline } from './judge-pipeline.js';
import { runJudgeSession, type SessionOutcome } from './judge-tool-session.js';
import { clamp, makeErroredResult, matchesExpectation } from './scorer-utils.js';

export interface RunScorerOptions {
    /** Required for `judge` scorers; ignored for other types. */
    llm?: LLMPort;
}

export async function runScorer(
    scorer: Scorer,
    ctx: ScorerContext,
    opts: RunScorerOptions = {},
): Promise<ScorerResultEntry> {
    switch (scorer.type) {
        case 'check':
            return runCheckScorer(scorer, ctx);
        case 'score':
            return runScoreScorer(scorer, ctx);
        case 'tool_usage':
            return runToolUsageScorer(scorer, ctx);
        case 'judge': {
            if (!opts.llm) {
                throw new Error(
                    'runScorer() requires opts.llm for judge scorers. Pass an LLM provider: runScorer(scorer, ctx, { llm: anthropicProvider })',
                );
            }
            if (scorer.tools && scorer.tools.length > 0) {
                const outcome = await runJudgeSession(
                    { scorer, ctx, llm: opts.llm as ToolCapableLLMPort },
                    { emitLogs: false },
                );
                return buildEntryFromOutcome(scorer, outcome);
            }
            const [entry] = await runJudgePipeline(scorer, ctx, { llm: opts.llm });
            return entry;
        }
    }
}

function buildEntryFromOutcome(scorer: JudgeScorer, outcome: SessionOutcome): ScorerResultEntry {
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

export async function runCheckScorer(
    scorer: CheckScorer,
    ctx: ScorerContext,
): Promise<ScorerResultEntry> {
    try {
        const passed = await scorer.fn(ctx);
        return {
            name: scorer.name,
            type: 'check',
            score: passed ? 1.0 : 0.0,
            weight: scorer.weight,
            details: passed ? 'passed' : 'failed',
            status: 'ok',
        };
    } catch (error: unknown) {
        return makeErroredResult('check', scorer.name, scorer.weight, error);
    }
}

export async function runScoreScorer(
    scorer: ScoreScorer,
    ctx: ScorerContext,
): Promise<ScorerResultEntry> {
    try {
        const raw = await scorer.fn(ctx);
        if (typeof raw === 'number') {
            return {
                name: scorer.name,
                type: 'score',
                score: clamp(raw),
                weight: scorer.weight,
                status: 'ok',
            };
        }
        return {
            name: scorer.name,
            type: 'score',
            score: clamp(raw.score),
            weight: scorer.weight,
            details: raw.details,
            status: 'ok',
        };
    } catch (error: unknown) {
        return makeErroredResult('score', scorer.name, scorer.weight, error);
    }
}

export async function runToolUsageScorer(
    scorer: ToolUsageScorer,
    ctx: ScorerContext,
): Promise<ScorerResultEntry> {
    try {
        const toolEvents = ctx.toolEvents;

        if (toolEvents.length === 0) {
            return {
                name: scorer.name,
                type: 'tool_usage',
                score: 0,
                weight: scorer.weight,
                details: 'No tool events captured',
                status: 'ok',
            };
        }

        const checks = scorer.expectations.map((expectation) => {
            const matches = toolEvents.filter((event) => matchesExpectation(event, expectation));
            const passed = matches.length >= (expectation.min ?? 1)
                && (expectation.max === undefined || matches.length <= expectation.max);
            return {
                passed,
                weight: expectation.weight ?? 1,
            };
        });

        const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
        const earnedWeight = checks.filter((c) => c.passed).reduce((sum, c) => sum + c.weight, 0);
        const score = totalWeight === 0 ? 0 : earnedWeight / totalWeight;

        return {
            name: scorer.name,
            type: 'tool_usage',
            score,
            weight: scorer.weight,
            details: `${earnedWeight}/${totalWeight} expectation weight passed`,
            status: 'ok',
        };
    } catch (error: unknown) {
        return makeErroredResult('tool_usage', scorer.name, scorer.weight, error);
    }
}
