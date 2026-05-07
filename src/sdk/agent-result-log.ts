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
        // Per-turn cost when the upstream provider reports it.
        // Conditionally spread so agents without cost data
        // never produce a zero-valued field that could be mistaken for
        // a free turn.
        ...(params.turnResult.costUsd !== undefined ? { cost_usd: params.turnResult.costUsd } : {}),
        ...getOutputMetrics(assistantMessage),
    };
}

/**
 * Build one `ask_batch` LogEntry per AskBus batch emitted in the given turn.
 * Callers push these to the session log before the `agent_result` entry for
 * that turn.
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

