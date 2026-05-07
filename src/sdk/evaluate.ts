import type {
    Agent,
    Scorer,
    EvalResult,
    RecordedEvalResult,
    ScorerResultEntry,
    ScorerContext,
    JudgeScorer,
    EvaluateOptions,
} from './types.js';
import type { ToolEvent } from '../tool-events.js';
import { extractSkillsFromLog } from '../tool-events.js';
import type { TrialResult, ScorerResult } from '../types.js';
import { getRuntime } from './eval-runtime.js';
import { runJudgePipeline } from './judge-pipeline.js';
import { runScorer } from './run-scorer.js';
import { createLLMClient } from '../utils/llm.js';
import { sandboxExec } from '../providers/sandbox-exec.js';
import { buildTranscript, loadRunSnapshot, WorkspaceMissingError } from './snapshots.js';
import fs from 'fs-extra';
import path from 'path';

export type OnScorerErrorMode = NonNullable<EvaluateOptions['onScorerError']>;

export class EvalScorerError extends Error {
    readonly scorerErrors: ScorerResultEntry[];
    readonly result: RecordedEvalResult;

    constructor(result: RecordedEvalResult, scorerErrors: ScorerResultEntry[]) {
        super(formatScorerErrorMessage(scorerErrors));
        this.name = 'EvalScorerError';
        this.result = result;
        this.scorerErrors = scorerErrors;
    }
}

type EvaluateFromSnapshot = (
    snapshotPath: string,
    scorers: Scorer[],
    opts?: EvaluateOptions,
) => Promise<EvalResult>;

type EvaluateFn = ((
    agent: Agent,
    scorers: Scorer[],
    opts?: EvaluateOptions,
) => Promise<EvalResult>) & {
    fromSnapshot: EvaluateFromSnapshot;
};

/**
 * Run scorers against a trial and compute a weighted average score.
 *
 * Pipeline phases:
 *   1. check + score scorers (parallel, deterministic)
 *   2. judge scorers (parallel, LLM calls) — skipped if fail-fast triggered
 *   3. toolUsage scorers (parallel) — skipped if fail-fast triggered
 *
 * Fail-fast: if any check scores 0 and failFast !== false, phases 2-3 are skipped.
 * score() returning 0 does NOT trigger fail-fast.
 */
// Track which agents have already had conversation tokens attributed.
// Local per-call: no module-level state, no cleanup export needed.
function makeEvaluateAgent() {
    const conversationAttributed = new WeakSet<Agent>();

    return async function evaluateAgent(
        agent: Agent,
        scorers: Scorer[],
        opts?: EvaluateOptions,
    ): Promise<EvalResult> {
        const toolEvents = agent.log
            .filter((e) => e.type === 'tool_event' && e.tool_event)
            .map((e) => e.tool_event as ToolEvent);

        const ctx: ScorerContext = {
            workspace: agent.workspace,
            log: agent.log,
            transcript: agent.transcript(),
            toolEvents,
            runCommand: (cmd: string) => agent.exec(cmd),
            artifacts: createSessionArtifacts(agent.workspace, toolEvents),
        };
        const trackedLLM = opts?.llm ?? agent.llm;

        // Snapshot conversation tokens BEFORE running scorers, for first-eval attribution.
        const before = trackedLLM.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
        // Snapshot conversation cost too. AgentImpl's `sendTurn` accumulates
        // per-turn `costUsd` onto `trackedLLM` via `addCost`, so by the time
        // `evaluate()` runs the pre-evaluate cost is the conversation's
        // accumulated agent-turn cost.
        const beforeCostUsd = trackedLLM.costUsd ?? 0;

        // measure() returns the delta consumed by this evaluate call.
        const { result: evalResult, tokens: deltaTokenUsage } = trackedLLM.measure
            ? await trackedLLM.measure(() => evaluateWithContext(ctx, scorers, { ...opts, llm: trackedLLM }))
            : await (async () => {
                const r = await evaluateWithContext(ctx, scorers, { ...opts, llm: trackedLLM });
                return { result: r, tokens: r.tokenUsage ?? { inputTokens: 0, outputTokens: 0 } };
            })();

        // Attribute conversation tokens on the first evaluate() for this agent.
        const isFirstEval = !conversationAttributed.has(agent);
        const conversationTokens = isFirstEval && (before.inputTokens > 0 || before.outputTokens > 0)
            ? { conversation_input_tokens: before.inputTokens, conversation_output_tokens: before.outputTokens }
            : undefined;
        // Same first-eval attribution rule for cost. Omitted entirely when
        // no conversation cost was captured (Codex / Cursor today).
        const conversationCost = isFirstEval && beforeCostUsd > 0
            ? { conversation_cost_usd: beforeCostUsd }
            : undefined;
        if (isFirstEval) conversationAttributed.add(agent);

        const recordedResult: RecordedEvalResult = {
            ...evalResult,
            tokenUsage: deltaTokenUsage,
            trial: buildTrialResult(
                agent.log,
                { ...evalResult, tokenUsage: deltaTokenUsage },
                conversationTokens,
                conversationCost,
            ),
        };
        getRuntime().onResult(recordedResult, agent);
        maybeThrowOnScorerErrors(recordedResult, opts?.onScorerError ?? 'skip');
        return recordedResult;
    };
}

const evaluateAgent = makeEvaluateAgent();

async function fromSnapshot(
    snapshotPath: string,
    scorers: Scorer[],
    opts?: EvaluateOptions,
): Promise<EvalResult> {
    const snapshot = await loadRunSnapshot(snapshotPath);
    const trackedLLM = opts?.llm ?? createLLMClient({ adapters: [{
        name: 'runtime', isAvailable: async () => true,
        call: (prompt, callOpts) => getRuntime().llm.call(prompt, callOpts),
    }] });
    const ctx: ScorerContext = {
        workspace: snapshot.workspace ?? '',
        log: snapshot.log,
        transcript: buildTranscript(snapshot.messages),
        toolEvents: snapshot.toolEvents,
        runCommand: async (cmd: string) => {
            const workspace = snapshot.workspace;
            if (!workspace) {
                throw new WorkspaceMissingError('Snapshot does not include a workspace path');
            }
            if (!(await fs.pathExists(workspace))) {
                throw new WorkspaceMissingError(`Snapshot workspace does not exist on disk: ${workspace}`);
            }
            return sandboxExec(cmd, { cwd: workspace, env: getProcessEnv() });
        },
        artifacts: createSessionArtifacts(snapshot.workspace ?? '', snapshot.toolEvents),
    };

    const evalResult = await evaluateWithContext(ctx, scorers, { ...opts, llm: trackedLLM });
    const recordedResult: RecordedEvalResult = {
        ...evalResult,
        trial: buildTrialResult(snapshot.log, evalResult),
    };
    maybeThrowOnScorerErrors(recordedResult, opts?.onScorerError ?? 'skip');
    return recordedResult;
}

async function evaluateWithContext(
    ctx: ScorerContext,
    scorers: Scorer[],
    opts?: EvaluateOptions,
): Promise<EvalResult> {
    const failFast = opts?.failFast ?? true;
    const trackedLLM = opts?.llm ?? createLLMClient({ adapters: [{
        name: 'runtime', isAvailable: async () => true,
        call: (prompt, callOpts) => getRuntime().llm.call(prompt, callOpts),
    }] });
    const onScorerError = opts?.onScorerError ?? 'skip';

    const phase1: Scorer[] = [];
    const phase2: Scorer[] = [];
    const phase3: Scorer[] = [];

    for (const g of scorers) {
        switch (g.type) {
            case 'check':
            case 'score':
                phase1.push(g);
                break;
            case 'judge':
                phase2.push(g);
                break;
            case 'tool_usage':
                phase3.push(g);
                break;
        }
    }

    const results: ScorerResultEntry[] = [];
    const phase1Results = await Promise.all(phase1.map((g) => runScorer(g, ctx)));
    results.push(...phase1Results);

    const anyCheckFailed = failFast && phase1Results.some(
        (r) => r.type === 'check' && r.status !== 'error' && r.score === 0,
    );

    if (anyCheckFailed) {
        for (const g of [...phase2, ...phase3]) {
            results.push(makeSkipped(g));
        }
    } else {
        const judgeResults = await runJudgePipeline(phase2 as JudgeScorer[], ctx, { llm: trackedLLM });
        results.push(...judgeResults);

        const phase3Results = await Promise.all(phase3.map((g) => runScorer(g, ctx)));
        results.push(...phase3Results);
    }

    const tokenUsage = trackedLLM.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
    const scoringResults = onScorerError === 'skip'
        ? results.filter((result) => result.status !== 'error')
        : results;
    const totalWeight = scoringResults.reduce((sum, r) => sum + r.weight, 0);
    const weightedSum = scoringResults.reduce((sum, r) => sum + r.score * r.weight, 0);
    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

    return {
        score,
        scorers: results,
        tokenUsage,
    };
}

function maybeThrowOnScorerErrors(result: RecordedEvalResult, mode: OnScorerErrorMode): void {
    if (mode !== 'fail') return;
    const scorerErrors = result.scorers.filter((entry) => entry.status === 'error');
    if (scorerErrors.length > 0) {
        throw new EvalScorerError(result, scorerErrors);
    }
}

function createSessionArtifacts(workspace: string, toolEvents: ToolEvent[]): ScorerContext['artifacts'] {
    const matchingArtifacts = (opts?: import('./types.js').SessionArtifactMatchOptions) => {
        const actions = opts?.actions ?? ['write_file', 'edit_file'];
        const seen = new Set<string>();
        const matches: Array<{ path: string; absolutePath: string }> = [];

        for (const event of toolEvents) {
            if (!actions.includes(event.action)) continue;
            const absolutePath = extractArtifactPath(event);
            if (!absolutePath) continue;
            const relativePath = normalizeArtifactPath(workspace, absolutePath);
            if (!matchesArtifactPattern(relativePath, opts?.pattern)) continue;
            if (seen.has(relativePath)) continue;
            seen.add(relativePath);
            matches.push({ path: relativePath, absolutePath });
        }

        return matches;
    };

    return {
        list: (opts) => matchingArtifacts(opts).map((artifact) => artifact.path),
        read: async (artifactPath) => {
            const absolutePath = resolveArtifactPath(workspace, artifactPath);
            return fs.readFile(absolutePath, 'utf8');
        },
        latest: async (opts) => {
            const matches = matchingArtifacts(opts);
            const latest = matches[matches.length - 1];
            if (!latest) return null;
            return {
                path: latest.path,
                content: await fs.readFile(latest.absolutePath, 'utf8'),
            };
        },
    };
}

function extractArtifactPath(event: ToolEvent): string | null {
    const candidates = [
        event.arguments?.path,
        event.arguments?.file,
        event.arguments?.file_path,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate;
        }
    }

    const summaryMatch = event.summary.match(/^(?:read_file|write_file|edit_file)\s+(.+)$/);
    return summaryMatch?.[1] ?? null;
}

function normalizeArtifactPath(workspace: string, artifactPath: string): string {
    if (!workspace || !path.isAbsolute(artifactPath)) {
        return artifactPath;
    }

    const relativePath = path.relative(workspace, artifactPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return artifactPath;
    }

    return relativePath;
}

function resolveArtifactPath(workspace: string, artifactPath: string): string {
    if (path.isAbsolute(artifactPath)) {
        return artifactPath;
    }
    if (!workspace) {
        throw new WorkspaceMissingError('Session artifact reads require a workspace for relative paths');
    }
    return path.join(workspace, artifactPath);
}

function matchesArtifactPattern(artifactPath: string, pattern?: string | RegExp): boolean {
    if (!pattern) return true;
    if (typeof pattern === 'string') return artifactPath.includes(pattern);
    return pattern.test(artifactPath);
}

function buildTrialResult(
    log: TrialResult['session_log'],
    result: EvalResult,
    conversationTokens?: { conversation_input_tokens: number; conversation_output_tokens: number },
    conversationCost?: { conversation_cost_usd: number },
): TrialResult {
    const nCommands = log.filter((entry) => entry.type === 'command').length;
    const skills = extractSkillsFromLog(log);

    return {
        trial_id: 0,
        reward: result.score,
        scorer_results: result.scorers.map(toTrialScorerResult),
        duration_ms: 0,
        n_commands: nCommands,
        input_tokens: result.tokenUsage?.inputTokens ?? 0,
        output_tokens: result.tokenUsage?.outputTokens ?? 0,
        ...conversationTokens,
        // `total_cost_usd` is intentionally NOT emitted here: total cost is
        // conservative — emitted only when every included component has a
        // known cost. Today judge LLM providers expose no cost, so a partial
        // total would mislead consumers. `conversation_cost_usd` is the only
        // guaranteed cost surface; future judge-cost work unlocks the total
        // field.
        ...conversationCost,
        session_log: [...log],
        ...(skills.length > 0 ? { skills_used: skills } : {}),
    };
}

function getProcessEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

export const evaluate = Object.assign(evaluateAgent, {
    fromSnapshot,
}) as EvaluateFn;

function toTrialScorerResult(result: ScorerResultEntry): ScorerResult {
    return {
        scorer_type: mapScorerType(result.type),
        score: result.score,
        weight: result.weight,
        details: result.details ?? '',
        status: result.status,
    };
}

function mapScorerType(type: ScorerResultEntry['type']): string {
    switch (type) {
        case 'check':
        case 'score':
            return 'deterministic';
        case 'judge':
            return 'llm_rubric';
        case 'tool_usage':
            return 'tool_usage';
    }
}

function makeSkipped(scorer: Scorer): ScorerResultEntry {
    return {
        name: scorer.name,
        type: scorer.type,
        score: 0,
        weight: scorer.weight ?? 1,
        details: 'skipped (fail-fast)',
        status: 'skipped',
    };
}

function formatScorerErrorMessage(scorerErrors: ScorerResultEntry[]): string {
    const joined = scorerErrors
        .map((result) => `${result.name}: ${result.details ?? 'unknown error'}`)
        .join('; ');
    return `Scorer evaluation failed: ${joined}`;
}
