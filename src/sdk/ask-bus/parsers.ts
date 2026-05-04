import type { AskBatch, AskOption, AskQuestion } from './types.js';
import type { ToolRequestUserInputParams } from '../../agents/codex-app-server/protocol/index.js';

export interface ClaudePermissionDenialShape {
    tool_name: string;
    tool_use_id?: string;
    tool_input?: Record<string, unknown>;
}

interface ClaudeAskUserQuestion {
    question?: unknown;
    header?: unknown;
    options?: Array<{ label: unknown; description?: unknown }>;
}

/**
 * Parse Claude `permission_denials` (filtered to `AskUserQuestion`) into a
 * normalized `AskBatch` with `lifecycle: 'post-hoc'`. Called at turn-result
 * assembly time. The caller also emits this batch into the per-conversation
 * `AskBus`; the `AskBatch` questions here and the eager
 * `AgentTurnResult.blockedPrompts` array are constructed from the same parsed
 * data — neither derives from the other.
 */
export function buildAskBatchFromClaudeDenials(
    denials: readonly ClaudePermissionDenialShape[],
    turnNumber: number,
): AskBatch {
    const filtered = denials.filter((d) => d.tool_name === 'AskUserQuestion');
    const firstToolUseId = filtered.find((d) => d.tool_use_id)?.tool_use_id;

    const questions: AskQuestion[] = [];
    let index = 0;
    for (const denial of filtered) {
        const input = (denial.tool_input ?? {}) as { questions?: ClaudeAskUserQuestion[] };
        for (const raw of input.questions ?? []) {
            const questionText = typeof raw.question === 'string' ? raw.question.trim() : '';
            if (!questionText) continue;

            const header = typeof raw.header === 'string' && raw.header.trim()
                ? raw.header.trim()
                : undefined;

            const rawOptions = Array.isArray(raw.options) ? raw.options : null;
            const options: AskOption[] | null = rawOptions === null
                ? null
                : rawOptions
                    .filter((o): o is { label: unknown; description?: unknown } =>
                        !!o && typeof o === 'object')
                    .map((o) => {
                        const label = String(o.label ?? '');
                        return typeof o.description === 'string' && o.description.length > 0
                            ? { label, description: o.description }
                            : { label };
                    });

            questions.push({
                id: `q-${index}`,
                ...(header ? { header } : {}),
                question: questionText,
                options,
                isOther: false,
                isSecret: false,
            });
            index++;
        }
    }

    const batchId = firstToolUseId ?? `claude-post-hoc-turn-${turnNumber}`;

    return {
        batchId,
        turnNumber,
        source: 'claude',
        lifecycle: 'post-hoc',
        sourceTool: 'AskUserQuestion',
        ...(firstToolUseId ? { toolUseId: firstToolUseId } : {}),
        questions,
    };
}

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
