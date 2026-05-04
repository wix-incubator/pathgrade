import type {
    JudgeScorer,
    ScorerContext,
    ScorerResultEntry,
} from './types.js';
import type { LLMPort, ToolCapableLLMPort } from '../utils/llm-types.js';
import { getRuntime } from './eval-runtime.js';
import { runJudgeWithTools } from './judge-tool-runner.js';
import { buildBatchedJudgePrompt, buildJudgePrompt } from './judge-prompt-builder.js';
import { clamp, getErrorMessage } from './scorer-utils.js';

export interface JudgePipelineOptions {
    /** Override the LLM. Defaults to getRuntime().llm at call time. */
    llm?: LLMPort;
}

export async function runJudgePipeline(
    judges: JudgeScorer | JudgeScorer[],
    ctx: ScorerContext,
    opts?: JudgePipelineOptions,
): Promise<ScorerResultEntry[]> {
    const list = Array.isArray(judges) ? judges : [judges];
    const llm = opts?.llm ?? getRuntime().llm;

    // Partition BEFORE model grouping: tool-using judges always run individually
    // against the tool-use runner. Batching would silently produce wrong scores
    // for a tool-using judge sharing a model group with a plain judge.
    const toolJudges = list.filter(hasTools);
    const plainJudges = list.filter((j) => !hasTools(j));

    const toolResultsPromise = Promise.all(
        toolJudges.map((j) => runJudgeWithToolsEntry(j, ctx, llm)),
    );

    const plainResultsPromise = runPlainJudges(plainJudges, ctx, llm);

    const [toolResults, plainResults] = await Promise.all([toolResultsPromise, plainResultsPromise]);
    // Preserve original order.
    const byName = new Map<string, ScorerResultEntry>();
    for (const r of [...toolResults, ...plainResults]) byName.set(r.name, r);
    return list.map((j) => byName.get(j.name)!);
}

function hasTools(j: JudgeScorer): boolean {
    return Array.isArray(j.tools) && j.tools.length > 0;
}

async function runJudgeWithToolsEntry(
    scorer: JudgeScorer,
    ctx: ScorerContext,
    llm: LLMPort,
): Promise<ScorerResultEntry> {
    const result = await runJudgeWithTools(scorer, ctx, llm as ToolCapableLLMPort);
    return result.entry;
}

async function runPlainJudges(
    judges: JudgeScorer[],
    ctx: ScorerContext,
    llm: LLMPort,
): Promise<ScorerResultEntry[]> {
    if (judges.length === 0) return [];

    if (judges.length <= 1) {
        return Promise.all(judges.map((g) => runJudgeScorer(g, ctx, llm)));
    }

    // Group judges by model — only batch judges with the same model
    const byModel = new Map<string, JudgeScorer[]>();
    for (const j of judges) {
        const key = j.model ?? '__default__';
        const group = byModel.get(key) ?? [];
        group.push(j);
        byModel.set(key, group);
    }

    // If all judges have different models, run individually
    if (byModel.size === judges.length) {
        return Promise.all(judges.map((g) => runJudgeScorer(g, ctx, llm)));
    }

    const groupResults = await Promise.all(
        [...byModel.values()].map(async (group) => {
            if (group.length === 1) {
                return [await runJudgeScorer(group[0], ctx, llm)];
            }

            // Attempt batched execution
            const batchResults = await runBatchedJudges(group, ctx, llm);
            if (batchResults) {
                return batchResults;
            }
            // Fallback to individual calls
            return Promise.all(group.map((g) => runJudgeScorer(g, ctx, llm)));
        }),
    );

    return groupResults.flat();
}

// --- Internal helpers ---

async function runBatchedJudges(
    judges: JudgeScorer[],
    ctx: ScorerContext,
    llm: LLMPort,
): Promise<ScorerResultEntry[] | null> {
    const resolvedInputs = await Promise.all(judges.map((judge) => resolveJudgeInput(judge, ctx)));
    const prompt = buildBatchedJudgePrompt(judges, ctx, resolvedInputs);

    try {
        const response = await llm.call(prompt, { model: judges[0].model, cacheControl: true });

        const cleaned = response.text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        if (!arrayMatch) return null;

        const parsed = JSON.parse(arrayMatch[0]) as Array<{ scorer_name?: string; score?: number; details?: string; reasoning?: string }>;
        if (!Array.isArray(parsed) || parsed.length !== judges.length) return null;

        return judges.map((j, i) => {
            const entry = parsed[i];
            return {
                name: j.name,
                type: 'judge' as const,
                score: clamp(parseFloat(String(entry.score)) || 0),
                weight: j.weight,
                details: entry.details || entry.reasoning || 'No details provided',
                status: 'ok' as const,
            };
        });
    } catch {
        return null;
    }
}

async function runJudgeScorer(scorer: JudgeScorer, ctx: ScorerContext, llm: LLMPort): Promise<ScorerResultEntry> {
    const input = await resolveJudgeInput(scorer, ctx);
    const prompt = buildJudgePrompt(scorer, ctx, input);

    const retries = getRetryCount(scorer.retry);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await llm.call(prompt, { model: scorer.model, cacheControl: true });
            return parseJudgeResponse(response.text, scorer);
        } catch (error: unknown) {
            if (attempt === retries) {
                return {
                    name: scorer.name,
                    type: 'judge',
                    score: 0,
                    weight: scorer.weight,
                    details: getErrorMessage(error),
                    status: 'error',
                };
            }
            await wait(1000 * (2 ** attempt));
        }
    }

    return {
        name: scorer.name,
        type: 'judge',
        score: 0,
        weight: scorer.weight,
        details: 'Judge retry loop exited unexpectedly',
        status: 'error',
    };
}

function parseJudgeResponse(text: string, scorer: JudgeScorer): ScorerResultEntry {
    try {
        const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                name: scorer.name,
                type: 'judge',
                score: clamp(parseFloat(parsed.score) || 0),
                weight: scorer.weight,
                details: parsed.details || parsed.reasoning || 'No details provided',
                status: 'ok',
            };
        }
    } catch {
        const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);
        if (scoreMatch) {
            return {
                name: scorer.name,
                type: 'judge',
                score: clamp(parseFloat(scoreMatch[1]) || 0),
                weight: scorer.weight,
                details: 'Parsed score from truncated LLM response',
                status: 'ok',
            };
        }
    }
    return {
        name: scorer.name,
        type: 'judge',
        score: 0,
        weight: scorer.weight,
        details: `Failed to parse LLM response: ${text.substring(0, 200)}`,
    };
}

async function resolveJudgeInput(
    scorer: JudgeScorer,
    ctx: ScorerContext,
): Promise<Record<string, unknown> | undefined> {
    if (!scorer.input) return undefined;
    if (typeof scorer.input === 'function') {
        return scorer.input(ctx);
    }
    return scorer.input;
}

function getRetryCount(retry: JudgeScorer['retry']): number {
    if (retry === true) {
        return 1;
    }
    if (typeof retry === 'number' && Number.isFinite(retry)) {
        return Math.max(0, Math.floor(retry));
    }
    return 0;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
