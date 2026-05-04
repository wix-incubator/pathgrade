import type { AgentName, AgentTransport } from './types.js';
import { getAgentCapabilities } from './types.js';
import type { AgentTurnResult, LogEntry } from '../types.js';

export interface RuntimePolicyDescriptor {
    id: string;
    version: string;
}

export interface RuntimePolicyRenderContext {
    agent: AgentName;
}

export interface RuntimePolicyAuditEntry {
    id: string;
    version: string;
    turns: number[];
}

export const NONINTERACTIVE_RUNTIME_POLICY: RuntimePolicyDescriptor = {
    id: 'noninteractive-user-question',
    version: '1',
};

const INTERACTIVE_TOOL_NAMES: Record<AgentName, string> = {
    claude: 'AskUserQuestion',
    codex: 'request_user_input',
    cursor: 'AskQuestion',
};

export function planRuntimePolicies(
    agent: AgentName,
    transport?: AgentTransport,
): RuntimePolicyDescriptor[] {
    const capabilities = getAgentCapabilities(agent, transport);
    if (!capabilities) {
        return [];
    }
    return capabilities.interactiveQuestionTransport === 'noninteractive'
        ? [NONINTERACTIVE_RUNTIME_POLICY]
        : [];
}

export function renderRuntimePolicy(
    policy: RuntimePolicyDescriptor,
    context: RuntimePolicyRenderContext,
): string {
    if (policy.id !== NONINTERACTIVE_RUNTIME_POLICY.id) {
        return '';
    }

    const toolName = INTERACTIVE_TOOL_NAMES[context.agent];

    return [
        'Runtime policy: non-interactive approval checkpoints',
        `If the structured user-question tool ${toolName} cannot execute, treat that event as a blocked checkpoint.`,
        'You must not retry the same checkpoint with paraphrases or formatting variants.',
        'You must not infer approval or rejection from earlier user intent.',
        'You must not continue past the blocked checkpoint.',
        'Ask only the earliest outstanding approval checkpoint.',
    ].join('\n');
}

export function renderRuntimePolicies(
    policies: RuntimePolicyDescriptor[],
    context: RuntimePolicyRenderContext,
): string {
    return policies
        .map((policy) => renderRuntimePolicy(policy, context))
        .filter((policy) => policy.length > 0)
        .join('\n\n');
}

export function prependRuntimePolicies(
    instruction: string,
    policies: RuntimePolicyDescriptor[],
    context: RuntimePolicyRenderContext,
): string {
    const rendered = renderRuntimePolicies(policies, context);
    if (!rendered) {
        return instruction;
    }

    // Claude slash commands only activate when the first line still starts with `/command`.
    // Preserve that first line, then inject runtime policy guidance immediately after it.
    if (instruction.startsWith('/')) {
        const newlineIndex = instruction.indexOf('\n');
        if (newlineIndex === -1) {
            return `${instruction}\n\n${rendered}`;
        }

        const firstLine = instruction.slice(0, newlineIndex);
        const remainder = instruction.slice(newlineIndex + 1);
        return `${firstLine}\n\n${rendered}\n${remainder}`;
    }

    return `${rendered}\n\n${instruction}`;
}

export function getRuntimePolicyLogMetadata(turnResult: AgentTurnResult): Record<string, unknown> {
    return turnResult.runtimePoliciesApplied && turnResult.runtimePoliciesApplied.length > 0
        ? { runtime_policies_applied: turnResult.runtimePoliciesApplied }
        : {};
}

export function extractRuntimePolicyAuditEntries(log: LogEntry[]): RuntimePolicyAuditEntry[] {
    const policies = new Map<string, RuntimePolicyAuditEntry>();

    for (const entry of log) {
        if (entry.type !== 'agent_result' || !entry.runtime_policies_applied || entry.runtime_policies_applied.length === 0) {
            continue;
        }

        for (const policy of entry.runtime_policies_applied) {
            const key = `${policy.id}@${policy.version}`;
            const existing = policies.get(key);
            if (!existing) {
                policies.set(key, {
                    id: policy.id,
                    version: policy.version,
                    turns: typeof entry.turn_number === 'number' ? [entry.turn_number] : [],
                });
                continue;
            }

            if (typeof entry.turn_number === 'number' && !existing.turns.includes(entry.turn_number)) {
                existing.turns.push(entry.turn_number);
            }
        }
    }

    return [...policies.values()].map((policy) => ({
        ...policy,
        turns: [...policy.turns].sort((a, b) => a - b),
    }));
}
