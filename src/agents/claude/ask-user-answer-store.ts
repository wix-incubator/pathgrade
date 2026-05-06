/**
 * Per-turn answer store shared by the ask-user-bridge (writer) and the
 * SDK-message-projector (reader). Issue #004.
 *
 * The bridge resolves an `AskUserQuestion` ask-bus batch synchronously inside
 * its `canUseTool` callback and writes the resulting `answers` map plus the
 * answer source (`'reaction' | 'fallback' | 'declined'`) keyed by the SDK's
 * `toolUseID`. After the turn's `for await` of the typed-message stream
 * completes, the projector consults the store while building the `ToolEvent`
 * for each `AskUserQuestion` tool-use block — the structured input the SDK
 * already gave us, plus the answer values and source the bridge attached.
 *
 * This is the only piece of cross-module state the bridge owns. It exists
 * because the SDK's `canUseTool` callback runs ahead of the assistant message
 * the projector ultimately sees — both sides need a join key.
 */

import type { AskAnswerSource } from '../../sdk/ask-bus/types.js';

export interface AskUserAnswerEntry {
    /** The SDK-shape `answers` map (question text → answer string). */
    readonly answers: Record<string, string>;
    /** Source tag from the `AskAnswer` resolution — what the projector stamps. */
    readonly source: AskAnswerSource;
}

export interface AskUserAnswerStore {
    record(toolUseId: string, entry: AskUserAnswerEntry): void;
    get(toolUseId: string | undefined): AskUserAnswerEntry | undefined;
}

export function createAskUserAnswerStore(): AskUserAnswerStore {
    const entries = new Map<string, AskUserAnswerEntry>();
    return {
        record(toolUseId, entry) {
            entries.set(toolUseId, entry);
        },
        get(toolUseId) {
            if (toolUseId === undefined) return undefined;
            return entries.get(toolUseId);
        },
    };
}
