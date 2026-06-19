import type { Agent, PathgradeTestMeta, RecordedEvalResult } from '../sdk/types.js';
import { subscribeToEvalResults, type ResultObserverHandle } from '../sdk/result-capture.js';
import {
    getCurrentCaseContext,
    installCaseContextProvider,
    runWithCaseContext,
    type CaseContext,
    type CaseContextProviderHandle,
} from '../sdk/case-context.js';
import { buildDiagnosticsReport } from '../reporters/diagnostics.js';
import path from 'node:path';

// Extend vitest's TaskMeta to carry pathgrade results from worker → reporter.
// Lives here because lifecycle.ts is the module that writes to task.meta.pathgrade.
declare module 'vitest' {
    interface TaskMeta {
        pathgrade?: PathgradeTestMeta[];
    }
}

type AfterEachFn = (fn: (ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) => void;
type AfterAllFn = (fn: () => Promise<void>) => void;
type AroundEachFn = (
    fn: (
        runTest: () => Promise<void>,
        ctx: { task: { id: string; name: string; meta: Record<string, unknown>; suite?: unknown } },
    ) => Promise<void>,
) => void;

// Agent tracking: each test creates its own agent(s) and calls evaluate() on them.
// Results are keyed by agent reference, which is unique per test.
const pendingAgents: Set<Agent> = new Set();
type AgentOwner =
    | { type: 'runner-case'; caseId: string }
    | { type: 'runner-suite-shared'; caseId: string }
    | { type: 'manual' };
interface PendingAgentResult {
    attribution:
        | { type: 'runner-case'; caseId: string }
        | { type: 'unattributed-runner' }
        | { type: 'legacy-unowned' };
    meta: PathgradeTestMeta;
}
const agentOwners = new WeakMap<Agent, AgentOwner>();
const agentResults = new WeakMap<Agent, PendingAgentResult[]>();
let resultCaptureHandle: ResultObserverHandle | null = null;
let fileContextHandle: CaseContextProviderHandle | null = null;

function currentTaskId(): string {
    try {
        return (globalThis as any).__vitest_worker__?.current?.id ?? '';
    } catch { return ''; }
}

function filePathForTask(task: { suite?: unknown }): string {
    let current = task.suite as { filepath?: unknown; suite?: unknown } | undefined;
    while (current) {
        if (typeof current.filepath === 'string') return current.filepath;
        current = current.suite as { filepath?: unknown; suite?: unknown } | undefined;
    }
    try {
        return (globalThis as any).__vitest_worker__?.filepath ?? '';
    } catch {
        return '';
    }
}

function caseContextForTask(task: { id: string; name: string; suite?: unknown }): CaseContext {
    return {
        caseId: task.id,
        caseName: task.name,
        filePath: filePathForTask(task),
        scope: 'runner-case',
    };
}

function currentFilePath(): string {
    try {
        return (globalThis as any).__vitest_worker__?.filepath ?? '';
    } catch {
        return '';
    }
}

function currentFileContext(): CaseContext | null {
    const filePath = currentFilePath();
    if (!filePath) return null;

    return {
        caseId: `file:${filePath}`,
        caseName: path.basename(filePath),
        filePath,
        scope: 'runner-suite-shared',
    };
}

function currentAgentOwner(): AgentOwner {
    const current = getCurrentCaseContext();
    if (current.status === 'active') {
        return current.context.scope === 'runner-case'
            ? { type: 'runner-case', caseId: current.context.caseId }
            : { type: 'runner-suite-shared', caseId: current.context.caseId };
    }

    const taskId = currentTaskId();
    return taskId ? { type: 'runner-case', caseId: taskId } : { type: 'manual' };
}

function belongsToTask(owner: AgentOwner | undefined, taskId: string): boolean {
    return owner?.type === 'runner-case' && owner.caseId === taskId;
}

function canFlushResultsToTask(owner: AgentOwner | undefined, taskId: string): boolean {
    if (!owner) return true;
    if (owner.type === 'runner-case') return owner.caseId === taskId;
    if (owner.type === 'runner-suite-shared') return true;
    return false;
}

function currentResultAttribution(owner: AgentOwner | undefined): PendingAgentResult['attribution'] {
    const current = getCurrentCaseContext();
    if (current.status === 'active' && current.context.scope === 'runner-case') {
        return { type: 'runner-case', caseId: current.context.caseId };
    }
    if (owner?.type === 'runner-case') return { type: 'runner-case', caseId: owner.caseId };

    const taskId = currentTaskId();
    if (taskId) return { type: 'runner-case', caseId: taskId };
    return owner ? { type: 'unattributed-runner' } : { type: 'legacy-unowned' };
}

function resultMatchesTask(entry: PendingAgentResult, taskId: string): boolean {
    if (entry.attribution.type === 'runner-case') return entry.attribution.caseId === taskId;
    return entry.attribution.type === 'legacy-unowned';
}

function trackAgent(agent: Agent): void {
    pendingAgents.add(agent);
    agentOwners.set(agent, currentAgentOwner());
}

function untrackAgent(agent: Agent): void {
    pendingAgents.delete(agent);
}

function releaseAgent(agent: Agent): void {
    const owner = agentOwners.get(agent);
    if (owner?.type !== 'manual') return;

    pendingAgents.delete(agent);
    agentResults.delete(agent);
    agentOwners.delete(agent);
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
        const owner = agentOwners.get(agent);
        const belongsToThisTest = belongsToTask(owner, task.id);

        const meta = agentResults.get(agent);
        const matchingMeta = meta?.filter((entry) => resultMatchesTask(entry, task.id));
        if (matchingMeta && matchingMeta.length > 0 && canFlushResultsToTask(owner, task.id)) {
            // Always flush pending results, even for shared agents
            results.push(...matchingMeta.map((entry) => entry.meta));
            const remainingMeta = meta?.filter((entry) => !resultMatchesTask(entry, task.id)) ?? [];
            if (remainingMeta.length > 0) {
                agentResults.set(agent, remainingMeta);
            } else {
                agentResults.delete(agent);
            }
        }

        if (belongsToThisTest) {
            const hasResultsForTask = matchingMeta && matchingMeta.length > 0;
            if (!hasResultsForTask) {
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
    const owner = agentOwners.get(agent);
    const conversationEnd = [...agent.log].reverse().find((entry) => entry.type === 'conversation_end');
    const completionReason = conversationEnd?.completion_reason ?? (agent.log.some((entry) => entry.type === 'agent_result') ? 'completed' : undefined);

    agentResults.get(agent)!.push({
        attribution: currentResultAttribution(owner),
        meta: {
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
        },
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
    resultCaptureHandle?.unsubscribe();
    resultCaptureHandle = null;
    fileContextHandle?.restore();
    fileContextHandle = null;
}

function install(afterEach: AfterEachFn, afterAll?: AfterAllFn, aroundEach?: AroundEachFn): void {
    resultCaptureHandle = subscribeToEvalResults(
        ({ result, agent }) => onResult(result, agent),
        { owner: 'adapter', key: 'vitest-lifecycle' },
    );
    fileContextHandle?.restore();
    fileContextHandle = installCaseContextProvider(currentFileContext);
    if (aroundEach) {
        aroundEach(async (runTest, { task }) => runWithCaseContext(caseContextForTask(task), runTest));
    }
    afterEach(async ({ task }) => flush(task));
    if (afterAll) {
        afterAll(async () => {
            await flushAll();
            fileContextHandle?.restore();
            fileContextHandle = null;
        });
    }
}

export const lifecycle = {
    trackAgent,
    untrackAgent,
    releaseAgent,
    flush,
    flushAll,
    onResult,
    reset,
    install,
};
