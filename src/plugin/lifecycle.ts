import { setRuntime } from '../sdk/eval-runtime.js';
import type { Agent, PathgradeTestMeta, RecordedEvalResult } from '../sdk/types.js';
import { buildDiagnosticsReport } from '../reporters/diagnostics.js';

// Extend vitest's TaskMeta to carry pathgrade results from worker → reporter.
// Lives here because lifecycle.ts is the module that writes to task.meta.pathgrade.
declare module 'vitest' {
    interface TaskMeta {
        pathgrade?: PathgradeTestMeta[];
    }
}

type AfterEachFn = (fn: (ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) => void;
type AfterAllFn = (fn: () => Promise<void>) => void;

// Agent tracking: each test creates its own agent(s) and calls evaluate() on them.
// Results are keyed by agent reference, which is unique per test.
const pendingAgents: Set<Agent> = new Set();
const agentTaskIds = new WeakMap<Agent, string>();
const agentResults = new WeakMap<Agent, PathgradeTestMeta[]>();

function currentTaskId(): string {
    try {
        return (globalThis as any).__vitest_worker__?.current?.id ?? '';
    } catch { return ''; }
}

function trackAgent(agent: Agent): void {
    pendingAgents.add(agent);
    const taskId = currentTaskId();
    if (taskId) agentTaskIds.set(agent, taskId);
}

function untrackAgent(agent: Agent): void {
    pendingAgents.delete(agent);
}

/**
 * Flush results and dispose agents for the current test. Agents created in
 * this test's scope are disposed after flushing. Shared agents (created in a
 * different scope, e.g. module-level or beforeAll) have their pending results
 * flushed but are kept alive for subsequent tests.
 */
async function flush(task: { id: string; meta: Pick<import('vitest').TaskMeta, 'pathgrade'> }): Promise<void> {
    const results: PathgradeTestMeta[] = [];
    const toDispose: Agent[] = [];

    for (const agent of pendingAgents) {
        const storedId = agentTaskIds.get(agent);
        const belongsToThisTest = !storedId || storedId === task.id;

        const meta = agentResults.get(agent);
        if (meta && meta.length > 0) {
            // Always flush pending results, even for shared agents
            results.push(...meta);
            agentResults.delete(agent);
        }

        if (belongsToThisTest) {
            if (!meta || meta.length === 0) {
                // evaluate() was never called — synthesize a trial from agent data
                // so the reporter still surfaces token usage and command counts.
                const synthTrial = synthesizeTrialFromAgent(agent);
                if (synthTrial) {
                    results.push(synthTrial);
                }
            }
            pendingAgents.delete(agent);
            toDispose.push(agent);
        }
    }

    if (results.length > 0) {
        task.meta.pathgrade = results;
    }

    await Promise.all(toDispose.map((a) => a.dispose().catch(() => {})));
}

function onResult(result: RecordedEvalResult, agent: Agent): void {
    if (!agentResults.has(agent)) {
        agentResults.set(agent, []);
    }
    const conversationEnd = [...agent.log].reverse().find((entry) => entry.type === 'conversation_end');
    const completionReason = conversationEnd?.completion_reason ?? (agent.log.some((entry) => entry.type === 'agent_result') ? 'completed' : undefined);

    agentResults.get(agent)!.push({
        score: result.score,
        scorers: result.scorers,
        trial: result.trial,
        diagnostics: buildDiagnosticsReport({
            completionReason,
            completionDetail: conversationEnd?.completion_detail,
            turnDetails: conversationEnd?.turn_details,
            reactionsFired: conversationEnd?.reactions_fired,
            score: result.score,
            scorers: result.scorers,
            log: agent.log,
        }),
    });
}

/**
 * When evaluate() is never called, synthesize a minimal trial from the agent's
 * log so the reporter still surfaces command count and token usage.
 */
function synthesizeTrialFromAgent(agent: Agent): PathgradeTestMeta | null {
    // Only synthesize if the agent actually ran (has log entries)
    if (agent.log.length === 0) return null;

    const nCommands = agent.log.filter((e) => e.type === 'command').length;
    const tokenUsage = agent.llm.tokenUsage;
    const conversationEnd = [...agent.log].reverse().find((entry) => entry.type === 'conversation_end');
    const completionReason = conversationEnd?.completion_reason ?? (agent.log.some((entry) => entry.type === 'agent_result') ? 'completed' : undefined);

    return {
        score: 1, // Will be overridden by vitest pass/fail in the reporter
        scorers: [],
        trial: {
            trial_id: 0,
            reward: 1,
            scorer_results: [],
            duration_ms: 0,
            n_commands: nCommands,
            input_tokens: tokenUsage?.inputTokens ?? 0,
            output_tokens: tokenUsage?.outputTokens ?? 0,
            session_log: [...agent.log],
        },
        diagnostics: buildDiagnosticsReport({
            completionReason,
            completionDetail: conversationEnd?.completion_detail,
            turnDetails: conversationEnd?.turn_details,
            reactionsFired: conversationEnd?.reactions_fired,
            score: 1,
            scorers: [],
            log: agent.log,
        }),
    };
}

/**
 * Dispose any agents still pending at end-of-file. Shared agents (created at
 * module scope or in beforeAll) have a stored task id that won't match any
 * per-test id in afterEach, so afterAll is their only disposal opportunity.
 * Without this, sandboxes leak and `debug: true` folders never get written.
 */
async function flushAll(): Promise<void> {
    const toDispose = [...pendingAgents];
    pendingAgents.clear();
    await Promise.all(toDispose.map((a) => a.dispose().catch(() => {})));
}

function reset(): void {
    pendingAgents.clear();
}

function install(afterEach: AfterEachFn, afterAll?: AfterAllFn): void {
    setRuntime({ onResult });
    afterEach(async ({ task }) => flush(task));
    if (afterAll) afterAll(async () => flushAll());
}

export const lifecycle = {
    trackAgent,
    untrackAgent,
    flush,
    flushAll,
    onResult,
    reset,
    install,
};
