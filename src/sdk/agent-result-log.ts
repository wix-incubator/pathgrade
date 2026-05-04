import type { AgentTurnResult, LogEntry } from '../types.js';
import type { AskBus } from './ask-bus/types.js';
import { getTurnResultLogMetadata, getVisibleAssistantMessage } from './visible-turn.js';

function getOutputMetrics(message: string): { output_lines: number; output_chars: number } {
    return {
        output_lines: message.split('\n').length,
        output_chars: message.length,
    };
}

export function buildModelAgentResultLogEntry(params: {
    timestamp: string;
    turnNumber?: number;
    durationMs?: number;
    turnResult: AgentTurnResult;
    assistantMessage?: string;
}): LogEntry {
    const assistantMessage = params.assistantMessage ?? getVisibleAssistantMessage(params.turnResult);

    return {
        type: 'agent_result',
        timestamp: params.timestamp,
        ...(params.turnNumber === undefined ? {} : { turn_number: params.turnNumber }),
        output: params.turnResult.rawOutput,
        assistant_message: assistantMessage,
        ...getTurnResultLogMetadata(params.turnResult),
        ...(params.durationMs === undefined ? {} : { duration_ms: params.durationMs }),
        ...getOutputMetrics(assistantMessage),
    };
}

/**
 * Build one `ask_batch` LogEntry per AskBus batch emitted in the given turn.
 * Callers push these to the session log before the `agent_result` entry for
 * that turn. Forward-compat writer for the schema added in RFC §Migration;
 * legacy `blocked_prompt_*` fields on `agent_result` are still written in
 * parallel during the deprecation window.
 */
export function buildAskBatchLogEntries(params: {
    askBus: AskBus;
    turnNumber: number;
    timestamp: string;
}): LogEntry[] {
    const batches = params.askBus.snapshot(params.turnNumber);
    return batches.map((batch) => ({
        type: 'ask_batch',
        timestamp: params.timestamp,
        turn_number: batch.turnNumber,
        batch_id: batch.batchId,
        source: batch.source,
        lifecycle: batch.lifecycle,
        source_tool: batch.sourceTool,
        ...(batch.toolUseId ? { tool_use_id: batch.toolUseId } : {}),
        question_count: batch.questions.length,
        ...(batch.lifecycle === 'live' ? { resolved: batch.resolution !== null } : {}),
    }));
}

export function buildSyntheticAgentResultLogEntry(params: {
    timestamp: string;
    assistantMessage: string;
    turnNumber?: number;
    extraFields?: Record<string, string | number | boolean | undefined>;
}): LogEntry {
    return {
        type: 'agent_result',
        timestamp: params.timestamp,
        ...(params.turnNumber === undefined ? {} : { turn_number: params.turnNumber }),
        output: '',
        assistant_message: params.assistantMessage,
        ...(params.extraFields ?? {}),
        ...getOutputMetrics(params.assistantMessage),
    };
}
