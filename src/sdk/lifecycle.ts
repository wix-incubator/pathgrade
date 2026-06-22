import type { Agent, PathgradeTestMeta, RecordedEvalResult } from './types.js';
import { getCurrentCaseContext } from './case-context.js';
import { buildDiagnosticsReport } from './diagnostics.js';

export type LifecycleAgentOwner =
    | { type: 'runner-case'; caseId: string }
    | { type: 'runner-suite-shared'; caseId: string }
    | { type: 'manual' };

type ResultAttribution =
    | { type: 'runner-case'; caseId: string }
    | { type: 'unattributed-runner' }
    | { type: 'legacy-unowned' };

interface PendingAgentResult {
    attribution: ResultAttribution;
    meta: PathgradeTestMeta;
}

interface FlushCaseInput {
    caseId: string;
}

const pendingAgents: Set<Agent> = new Set();
const agentOwners = new WeakMap<Agent, LifecycleAgentOwner>();
const agentResults = new WeakMap<Agent, PendingAgentResult[]>();

function currentAgentOwner(): LifecycleAgentOwner {
    const current = getCurrentCaseContext();
    if (current.status !== 'active') return { type: 'manual' };

    return current.context.scope === 'runner-case'
        ? { type: 'runner-case', caseId: current.context.caseId }
        : { type: 'runner-suite-shared', caseId: current.context.caseId };
}

function belongsToCase(owner: LifecycleAgentOwner | undefined, caseId: string): boolean {
    return !owner || (owner.type === 'runner-case' && owner.caseId === caseId);
}

function canFlushResultsToCase(owner: LifecycleAgentOwner | undefined, caseId: string): boolean {
    if (!owner) return true;
    if (owner.type === 'runner-case') return owner.caseId === caseId;
    if (owner.type === 'runner-suite-shared') return true;
    return false;
}

function currentResultAttribution(owner: LifecycleAgentOwner | undefined): ResultAttribution {
    const current = getCurrentCaseContext();
    if (current.status === 'active' && current.context.scope === 'runner-case') {
        return { type: 'runner-case', caseId: current.context.caseId };
    }
    if (owner?.type === 'runner-case') return { type: 'runner-case', caseId: owner.caseId };
    if (!owner) return { type: 'legacy-unowned' };
    return { type: 'unattributed-runner' };
}

function getAgentOwner(agent: Agent): LifecycleAgentOwner | undefined {
    return agentOwners.get(agent);
}

function resultMatchesCase(entry: PendingAgentResult, caseId: string): boolean {
    if (entry.attribution.type === 'runner-case') return entry.attribution.caseId === caseId;
    return entry.attribution.type === 'legacy-unowned';
}

function registerAgent(agent: Agent, owner?: LifecycleAgentOwner | null): void {
    pendingAgents.add(agent);
    const resolvedOwner = owner === undefined ? currentAgentOwner() : owner;
    if (resolvedOwner) {
        agentOwners.set(agent, resolvedOwner);
    }
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

function recordResult(result: RecordedEvalResult, agent: Agent, attribution?: ResultAttribution): void {
    if (!agentResults.has(agent)) {
        agentResults.set(agent, []);
    }
    const owner = agentOwners.get(agent);
    const conversationEnd = [...agent.log].reverse().find((entry) => entry.type === 'conversation_end');
    const completionReason = conversationEnd?.completion_reason ?? (agent.log.some((entry) => entry.type === 'agent_result') ? 'completed' : undefined);

    agentResults.get(agent)!.push({
        attribution: attribution ?? currentResultAttribution(owner),
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

async function flushCase(input: FlushCaseInput): Promise<PathgradeTestMeta[]> {
    const results: PathgradeTestMeta[] = [];
    const toDispose: Agent[] = [];

    for (const agent of pendingAgents) {
        const owner = agentOwners.get(agent);
        const belongsToThisCase = belongsToCase(owner, input.caseId);

        const meta = agentResults.get(agent);
        const matchingMeta = meta?.filter((entry) => resultMatchesCase(entry, input.caseId));
        if (matchingMeta && matchingMeta.length > 0 && canFlushResultsToCase(owner, input.caseId)) {
            results.push(...matchingMeta.map((entry) => entry.meta));
            const remainingMeta = meta?.filter((entry) => !resultMatchesCase(entry, input.caseId)) ?? [];
            if (remainingMeta.length > 0) {
                agentResults.set(agent, remainingMeta);
            } else {
                agentResults.delete(agent);
            }
        }

        if (belongsToThisCase) {
            const hasResultsForCase = matchingMeta && matchingMeta.length > 0;
            if (!hasResultsForCase) {
                const synthTrial = synthesizeTrialFromAgent(agent);
                if (synthTrial) {
                    results.push(synthTrial);
                }
            }
            pendingAgents.delete(agent);
            agentOwners.delete(agent);
            toDispose.push(agent);
        }
    }

    await Promise.all(toDispose.map((agent) => agent.dispose().catch(() => {})));
    return results;
}

function synthesizeTrialFromAgent(agent: Agent): PathgradeTestMeta | null {
    if (agent.log.length === 0) return null;

    const nCommands = agent.log.filter((entry) => entry.type === 'command').length;
    const tokenUsage = agent.llm.tokenUsage;
    const conversationEnd = [...agent.log].reverse().find((entry) => entry.type === 'conversation_end');
    const completionReason = conversationEnd?.completion_reason ?? (agent.log.some((entry) => entry.type === 'agent_result') ? 'completed' : undefined);

    return {
        score: 1,
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

async function cleanupAll(): Promise<void> {
    const toDispose = [...pendingAgents];
    pendingAgents.clear();
    await Promise.all(toDispose.map((agent) => agent.dispose().catch(() => {})));
}

function reset(): void {
    pendingAgents.clear();
}

export const lifecycleCore = {
    registerAgent,
    untrackAgent,
    releaseAgent,
    getAgentOwner,
    recordResult,
    flushCase,
    cleanupAll,
    reset,
};
