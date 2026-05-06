import type { AgentTurnResult } from '../types.js';
import { getRuntimePolicyLogMetadata } from './runtime-policy.js';

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
        toolEvents: [],
    };
}

export function getTurnResultLogMetadata(turnResult: AgentTurnResult): Record<string, unknown> {
    return {
        assistant_message_source: turnResult.visibleAssistantMessageSource,
        ...getRuntimePolicyLogMetadata(turnResult),
    };
}
