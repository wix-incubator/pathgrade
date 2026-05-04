import type { LogEntry } from '../types.js';
import type { ToolEvent } from '../tool-events.js';
import type { AgentName, ConversationResult, Message, TurnTiming } from './types.js';
import fs from 'fs-extra';

export const RUN_SNAPSHOT_VERSION = 1;

export interface RunSnapshot {
    version: 1;
    timestamp: string;
    agent: AgentName;
    messages: Message[];
    log: LogEntry[];
    toolEvents: ToolEvent[];
    turnTimings: TurnTiming[];
    conversationResult: {
        turns: number;
        completionReason: ConversationResult['completionReason'];
        completionDetail?: string;
        turnTimings: TurnTiming[];
    };
    workspace: string | null;
}

export function buildRunSnapshot(params: {
    agent: AgentName;
    messages: Message[];
    log: LogEntry[];
    conversationResult: ConversationResult;
    workspace: string | null;
    timestamp?: string;
}): RunSnapshot {
    const { agent, messages, log, conversationResult, workspace, timestamp } = params;
    const toolEvents = log
        .filter((entry) => entry.type === 'tool_event' && entry.tool_event)
        .map((entry) => entry.tool_event as ToolEvent);

    return {
        version: RUN_SNAPSHOT_VERSION,
        timestamp: timestamp ?? new Date().toISOString(),
        agent,
        messages: [...messages],
        log: [...log],
        toolEvents,
        turnTimings: [...conversationResult.turnTimings],
        conversationResult: {
            turns: conversationResult.turns,
            completionReason: conversationResult.completionReason,
            ...(conversationResult.completionDetail ? { completionDetail: conversationResult.completionDetail } : {}),
            turnTimings: [...conversationResult.turnTimings],
        },
        workspace,
    };
}

export class SnapshotParseError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'SnapshotParseError';
        if (options?.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = options.cause;
        }
    }
}

export class SnapshotVersionError extends Error {
    constructor(version: number) {
        super(`Unsupported snapshot version: ${version}`);
        this.name = 'SnapshotVersionError';
    }
}

export class WorkspaceMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceMissingError';
    }
}

const ASK_SOURCE_VALUES = new Set(['claude', 'codex-app-server', 'cursor']);
const ASK_LIFECYCLE_VALUES = new Set(['live', 'post-hoc']);

function validateLogEntries(entries: unknown[]): void {
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') {
            throw new SnapshotParseError(`Snapshot log entry ${i} must be an object`);
        }
        const record = entry as Record<string, unknown>;
        if (record.type === 'ask_batch') {
            if (typeof record.batch_id !== 'string') {
                throw new SnapshotParseError(`ask_batch log entry ${i} is missing required field: batch_id`);
            }
            if (typeof record.turn_number !== 'number') {
                throw new SnapshotParseError(`ask_batch log entry ${i} is missing required field: turn_number`);
            }
            if (typeof record.source !== 'string' || !ASK_SOURCE_VALUES.has(record.source)) {
                throw new SnapshotParseError(`ask_batch log entry ${i} has invalid source: ${String(record.source)}`);
            }
            if (typeof record.lifecycle !== 'string' || !ASK_LIFECYCLE_VALUES.has(record.lifecycle)) {
                throw new SnapshotParseError(`ask_batch log entry ${i} has invalid lifecycle: ${String(record.lifecycle)}`);
            }
            if (typeof record.source_tool !== 'string') {
                throw new SnapshotParseError(`ask_batch log entry ${i} is missing required field: source_tool`);
            }
            if (typeof record.question_count !== 'number') {
                throw new SnapshotParseError(`ask_batch log entry ${i} is missing required field: question_count`);
            }
        }
        // Legacy blocked_prompt_* fields on agent_result entries remain accepted
        // without additional validation — their schema is owned by the writer.
    }
}

export function buildTranscript(messages: Message[]): string {
    return messages
        .map((msg) => `[${msg.role === 'user' ? 'User' : 'Agent'}]\n${msg.content}`)
        .join('\n\n');
}

export async function loadRunSnapshot(snapshotPath: string): Promise<RunSnapshot> {
    let parsed: unknown;
    try {
        parsed = await fs.readJSON(snapshotPath);
    } catch (error) {
        throw new SnapshotParseError(`Failed to read snapshot JSON from ${snapshotPath}`, { cause: error });
    }

    return validateRunSnapshot(parsed);
}

function validateRunSnapshot(input: unknown): RunSnapshot {
    if (!input || typeof input !== 'object') {
        throw new SnapshotParseError('Snapshot must be a JSON object');
    }

    const snapshot = input as Partial<RunSnapshot>;
    if (typeof snapshot.version !== 'number') {
        throw new SnapshotParseError('Snapshot is missing required field: version');
    }
    if (snapshot.version > RUN_SNAPSHOT_VERSION) {
        throw new SnapshotVersionError(snapshot.version);
    }
    if (!Array.isArray(snapshot.messages)) {
        throw new SnapshotParseError('Snapshot is missing required field: messages');
    }
    if (!Array.isArray(snapshot.log)) {
        throw new SnapshotParseError('Snapshot is missing required field: log');
    }
    validateLogEntries(snapshot.log);
    if (!Array.isArray(snapshot.toolEvents)) {
        throw new SnapshotParseError('Snapshot is missing required field: toolEvents');
    }
    if (!snapshot.conversationResult || typeof snapshot.conversationResult !== 'object') {
        throw new SnapshotParseError('Snapshot is missing required field: conversationResult');
    }
    if (!Array.isArray(snapshot.conversationResult.turnTimings)) {
        throw new SnapshotParseError('Snapshot conversationResult is missing required field: turnTimings');
    }
    if (typeof snapshot.conversationResult.turns !== 'number') {
        throw new SnapshotParseError('Snapshot conversationResult is missing required field: turns');
    }
    if (typeof snapshot.conversationResult.completionReason !== 'string') {
        throw new SnapshotParseError('Snapshot conversationResult is missing required field: completionReason');
    }

    const turnTimings = Array.isArray(snapshot.turnTimings)
        ? snapshot.turnTimings
        : snapshot.conversationResult.turnTimings;

    return {
        version: RUN_SNAPSHOT_VERSION,
        timestamp: typeof snapshot.timestamp === 'string' ? snapshot.timestamp : new Date(0).toISOString(),
        agent: snapshot.agent === 'claude' || snapshot.agent === 'codex' || snapshot.agent === 'cursor' ? snapshot.agent : 'claude',
        messages: snapshot.messages,
        log: snapshot.log,
        toolEvents: snapshot.toolEvents,
        turnTimings,
        conversationResult: {
            turns: snapshot.conversationResult.turns,
            completionReason: snapshot.conversationResult.completionReason,
            ...(snapshot.conversationResult.completionDetail
                ? { completionDetail: snapshot.conversationResult.completionDetail }
                : {}),
            turnTimings: snapshot.conversationResult.turnTimings,
        },
        workspace: typeof snapshot.workspace === 'string' ? snapshot.workspace : null,
    };
}
