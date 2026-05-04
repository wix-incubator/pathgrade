import type { AgentTurnResult, BlockedInteractivePrompt } from '../types.js';
import { formatBlockedPrompt } from './visible-turn.js';

export interface PendingBlockedPromptQueue {
    prompts: BlockedInteractivePrompt[];
    activeIndex: number;
    sourceTurn: number;
}

export function createPendingBlockedPromptQueue(
    turnResult: AgentTurnResult,
    sourceTurn: number,
): PendingBlockedPromptQueue | null {
    if (turnResult.blockedPrompts.length === 0) {
        return null;
    }
    return {
        prompts: turnResult.blockedPrompts,
        activeIndex: 0,
        sourceTurn,
    };
}

export function advancePendingBlockedPromptQueue(
    queue: PendingBlockedPromptQueue,
): { queue: PendingBlockedPromptQueue | null; nextPromptMessage?: string } {
    const nextIndex = queue.activeIndex + 1;
    if (nextIndex >= queue.prompts.length) {
        return { queue: null };
    }
    const nextQueue: PendingBlockedPromptQueue = {
        ...queue,
        activeIndex: nextIndex,
    };
    return {
        queue: nextQueue,
        nextPromptMessage: formatBlockedPrompt(nextQueue.prompts[nextQueue.activeIndex]),
    };
}

export function getBlockedPromptReplayLogMetadata(
    queue: PendingBlockedPromptQueue,
): Record<string, string | number | boolean | undefined> {
    const prompt = queue.prompts[queue.activeIndex];
    return {
        assistant_message_source: 'blocked_prompt',
        synthetic_blocked_prompt: true,
        blocked_prompt_source_turn: queue.sourceTurn,
        blocked_prompt_index: prompt.order,
        blocked_prompt_count: queue.prompts.length,
        blocked_prompt_source_tool: prompt.sourceTool,
        blocked_prompt_tool_use_id: prompt.toolUseId,
    };
}

function normalizeOptionText(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeBlockedPromptReply(
    queue: PendingBlockedPromptQueue,
    reply: string,
): string {
    const normalizedReply = normalizeOptionText(reply);
    if (!normalizedReply) {
        return reply;
    }

    const options = queue.prompts[queue.activeIndex]?.options ?? [];
    if (options.length === 0) {
        return reply;
    }

    const exactMatches = options.filter((option) => normalizeOptionText(option.label) === normalizedReply);
    if (exactMatches.length === 1) {
        return exactMatches[0].label;
    }

    const prefixMatches = options.filter((option) => normalizeOptionText(option.label).startsWith(normalizedReply));
    if (prefixMatches.length === 1) {
        return prefixMatches[0].label;
    }

    return reply;
}
