import type { AskBatch, AskQuestion } from './types.js';
import type { ToolRequestUserInputParams } from '../../agents/codex-app-server/protocol/index.js';

/**
 * Parse Codex `ToolRequestUserInputParams` (the `item/tool/requestUserInput`
 * server-request params) into a normalized `AskBatch` with
 * `lifecycle: 'live'`. Used by the Codex `app-server` driver (slice #6) and by
 * the adapter-layer parity test (slice #9).
 */
export function buildAskBatchFromCodexRequestUserInput(
    params: ToolRequestUserInputParams,
    turnNumber: number,
): AskBatch {
    const questions: AskQuestion[] = params.questions.map((q) => ({
        id: q.id,
        ...(q.header ? { header: q.header } : {}),
        question: q.question,
        options: q.options === null
            ? null
            : q.options.map((o) => ({
                label: o.label,
                ...(o.description ? { description: o.description } : {}),
            })),
        isOther: q.isOther,
        isSecret: q.isSecret,
    }));

    return {
        batchId: params.itemId,
        turnNumber,
        source: 'codex-app-server',
        lifecycle: 'live',
        sourceTool: 'request_user_input',
        toolUseId: params.itemId,
        questions,
    };
}
