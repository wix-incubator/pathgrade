import type { AgentTurnResult, BlockedInteractivePrompt } from '../types.js';
import { getRuntimePolicyLogMetadata } from './runtime-policy.js';

export function formatBlockedPrompt(prompt: BlockedInteractivePrompt): string {
    const parts: string[] = [];
    if (prompt.header) {
        parts.push(`**${prompt.header}**`);
    }
    parts.push(prompt.prompt);
    for (const option of prompt.options) {
        const description = option.description ? ` - ${option.description}` : '';
        parts.push(`- **${option.label}**${description}`);
    }
    return parts.join('\n');
}

export function getVisibleAssistantMessage(turnResult: AgentTurnResult): string {
    return turnResult.visibleAssistantMessage || turnResult.assistantMessage || turnResult.rawOutput;
}

export function normalizeTurnResult(result: string | AgentTurnResult): AgentTurnResult {
    if (typeof result !== 'string') {
        return result;
    }
    return {
        rawOutput: result,
        assistantMessage: result,
        visibleAssistantMessage: result,
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        blockedPrompts: [],
        toolEvents: [],
    };
}

export function getTurnResultLogMetadata(turnResult: AgentTurnResult): Record<string, unknown> {
    const runtimePolicyMetadata = getRuntimePolicyLogMetadata(turnResult);

    if (turnResult.visibleAssistantMessageSource !== 'blocked_prompt' || turnResult.blockedPrompts.length === 0) {
        return {
            assistant_message_source: turnResult.visibleAssistantMessageSource,
            ...runtimePolicyMetadata,
        };
    }

    const prompt = turnResult.blockedPrompts[0];
    return {
        assistant_message_source: 'blocked_prompt',
        raw_assistant_message: turnResult.assistantMessage || undefined,
        blocked_prompt_index: prompt.order,
        blocked_prompt_count: turnResult.blockedPrompts.length,
        blocked_prompt_source_tool: prompt.sourceTool,
        blocked_prompt_tool_use_id: prompt.toolUseId,
        ...runtimePolicyMetadata,
    };
}
