import type { ToolEvent } from '../../tool-events.js';

export interface ClaudeDeniedMcpEventStore {
    record(toolUseId: string, event: ToolEvent): void;
    get(toolUseId: string | undefined): ToolEvent | undefined;
    all(): ToolEvent[];
    clear(): void;
}

export function createClaudeDeniedMcpEventStore(): ClaudeDeniedMcpEventStore {
    const byToolUseId = new Map<string, ToolEvent>();
    return {
        record(toolUseId, event) {
            byToolUseId.set(toolUseId, event);
        },
        get(toolUseId) {
            return toolUseId ? byToolUseId.get(toolUseId) : undefined;
        },
        all() {
            return [...byToolUseId.values()];
        },
        clear() {
            byToolUseId.clear();
        },
    };
}
