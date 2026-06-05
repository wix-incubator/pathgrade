import type { ToolEvent } from '../tool-events.js';

/**
 * Error thrown by an agent driver when the subprocess dies mid-turn under a
 * stateful transport (e.g. Codex `app-server`). Carries enough diagnostic
 * information for `runConversation` to build `ConversationResult.crashDiagnostic`.
 */
export class AgentCrashError extends Error {
    readonly pid?: number;
    readonly signal?: NodeJS.Signals | null;
    readonly exitCode?: number | null;
    /** Non-ask-user tool events captured before the crash, if available. */
    partialToolEvents?: ToolEvent[];

    constructor(
        message: string,
        info: {
            pid?: number;
            signal?: NodeJS.Signals | string | null;
            exitCode?: number | null;
            partialToolEvents?: ToolEvent[];
        },
    ) {
        super(message);
        this.name = 'AgentCrashError';
        this.pid = info.pid;
        this.signal = info.signal as NodeJS.Signals | null | undefined;
        this.exitCode = info.exitCode ?? null;
        this.partialToolEvents = info.partialToolEvents;
    }
}
