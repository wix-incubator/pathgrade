export type AskSource = 'claude' | 'codex-app-server' | 'cursor';

/**
 * Lifecycle of a question batch — determines whether answers flow back and when.
 *
 * - 'live'     — mid-turn, synchronous. Driver MUST await resolution before
 *                proceeding (Codex app-server ToolRequestUserInput).
 * - 'post-hoc' — the agent already moved past this question by the time
 *                pathgrade saw it. Observable but unresolvable (Claude denial;
 *                Cursor v1). Codex exec simply doesn't emit; no dedicated tag.
 */
export type AskLifecycle = 'live' | 'post-hoc';

export interface AskOption {
    readonly label: string;
    readonly description?: string;
}

export interface AskQuestion {
    readonly id: string;
    readonly header?: string;
    readonly question: string;
    readonly options: readonly AskOption[] | null;
    readonly isOther: boolean;
    readonly isSecret: boolean;
}

export interface AskBatch {
    readonly batchId: string;
    readonly turnNumber: number;
    readonly source: AskSource;
    readonly lifecycle: AskLifecycle;
    readonly sourceTool: string;
    readonly toolUseId?: string;
    readonly questions: readonly AskQuestion[];
}

export type AskAnswerSource = 'reaction' | 'fallback' | 'declined';

export interface AskAnswer {
    readonly questionId: string;
    readonly values: readonly string[];
    readonly source: AskAnswerSource;
}

export interface AskResolution {
    readonly answers: readonly AskAnswer[];
}

export interface AskAnswerSnapshot {
    readonly questionId: string;
    /** isSecret answers with source='reaction' or 'fallback' appear here as ['<redacted>']. */
    readonly values: readonly string[];
    readonly source: AskAnswerSource;
}

export interface AskResolutionSnapshot {
    readonly answers: readonly AskAnswerSnapshot[];
}

export interface AskBatchSnapshot extends AskBatch {
    readonly resolution: AskResolutionSnapshot | null;
}

export type AskHandler = (
    batch: AskBatch,
    respond: (resolution: AskResolution) => void,
) => void;

export type Unsubscribe = () => void;

export interface AskHandle {
    readonly batchId: string;
    /**
     * Resolves to the resolution the first subscriber provided, or null for
     * post-hoc batches. Always resolves — never pending forever.
     * Timeout-bounded for 'live' lifecycle.
     */
    readonly resolution: Promise<AskResolution | null>;
}

export interface AskBus {
    emit(batch: AskBatch): AskHandle;
    onAsk(handler: AskHandler): Unsubscribe;
    snapshot(turnNumber?: number): readonly AskBatchSnapshot[];
}
