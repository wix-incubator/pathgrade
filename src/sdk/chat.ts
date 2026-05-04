import type { AgentTurnResult, CommandResult, LogEntry } from '../types.js';
import type { ChatSession, Message } from './types.js';
import { buildModelAgentResultLogEntry, buildSyntheticAgentResultLogEntry } from './agent-result-log.js';
import { getVisibleAssistantMessage } from './visible-turn.js';
import type { VerboseEmitter } from '../reporters/verbose-emitter.js';
import {
    advancePendingBlockedPromptQueue,
    createPendingBlockedPromptQueue,
    getBlockedPromptReplayLogMetadata,
    normalizeBlockedPromptReply,
    type PendingBlockedPromptQueue,
} from './blocked-prompt-queue.js';

export interface ChatSessionDeps {
    /** Mutable reference to the trial's messages array */
    messages: Message[];
    /** Mutable reference to the trial's log array */
    log: LogEntry[];
    /** Run a command in the trial workspace */
    exec: (cmd: string) => Promise<CommandResult>;
    /** Send a reply to the agent with per-turn timeout handling */
    sendTurn: (message: string) => Promise<AgentTurnResult>;
    /** Verbose event sink (no-op when disabled) */
    verbose?: VerboseEmitter;
}

export class ChatSessionImpl implements ChatSession {
    private _turn: number;
    private _done = false;
    private _lastMessage: string;
    private pendingBlockedPromptQueue: PendingBlockedPromptQueue | null;
    private deps: ChatSessionDeps;

    constructor(firstTurnResult: AgentTurnResult, deps: ChatSessionDeps) {
        this._turn = 1;
        this._lastMessage = getVisibleAssistantMessage(firstTurnResult);
        this.pendingBlockedPromptQueue = createPendingBlockedPromptQueue(firstTurnResult, this._turn);
        this.deps = deps;
    }

    get turn(): number {
        return this._turn;
    }

    get done(): boolean {
        return this._done;
    }

    get lastMessage(): string {
        return this._lastMessage;
    }

    get messages(): Message[] {
        return this.deps.messages;
    }

    async reply(message: string): Promise<void> {
        if (this._done) {
            throw new Error('Cannot reply() on a done ChatSession');
        }

        const timestamp = () => new Date().toISOString();
        const syntheticTurnNumber = this.pendingBlockedPromptQueue?.sourceTurn ?? (this._turn + 1);
        const normalizedMessage = this.pendingBlockedPromptQueue
            ? normalizeBlockedPromptReply(this.pendingBlockedPromptQueue, message)
            : message;

        this.deps.messages.push({ role: 'user', content: normalizedMessage });
        this.deps.log.push({
            type: 'user_reply',
            timestamp: timestamp(),
            instruction: normalizedMessage,
            turn_number: syntheticTurnNumber,
        });
        this.deps.verbose?.turnStart({
            turn: syntheticTurnNumber,
            kind: 'user_reply',
            message: normalizedMessage,
        });

        if (this.pendingBlockedPromptQueue) {
            const replay = advancePendingBlockedPromptQueue(this.pendingBlockedPromptQueue);
            this.pendingBlockedPromptQueue = replay.queue;
            if (replay.nextPromptMessage) {
                this.deps.log.push(buildSyntheticAgentResultLogEntry({
                    timestamp: timestamp(),
                    assistantMessage: replay.nextPromptMessage,
                    extraFields: getBlockedPromptReplayLogMetadata(replay.queue!),
                }));
                this.deps.messages.push({ role: 'agent', content: replay.nextPromptMessage });
                this._lastMessage = replay.nextPromptMessage;
                return;
            }
        }

        const turnNumber = this._turn + 1;

        let turnResult: AgentTurnResult;
        const turnStart = Date.now();
        try {
            turnResult = await this.deps.sendTurn(normalizedMessage);
        } catch (err) {
            this._done = true;
            throw err;
        }

        const response = getVisibleAssistantMessage(turnResult);
        const durationMs = Date.now() - turnStart;

        this.deps.log.push(buildModelAgentResultLogEntry({
            timestamp: timestamp(),
            turnNumber,
            durationMs,
            turnResult,
            assistantMessage: response,
        }));

        for (const toolEvent of turnResult.toolEvents) {
            this.deps.log.push({
                type: 'tool_event',
                timestamp: timestamp(),
                tool_event: toolEvent,
            });
            this.deps.verbose?.toolEvent({
                action: toolEvent.action,
                summary: toolEvent.summary,
            });
        }

        this.deps.messages.push({ role: 'agent', content: response });
        this.deps.verbose?.turnEnd({
            turn: turnNumber,
            durationMs,
            outputLines: response.split('\n').length,
            messagePreview: response,
        });
        this.pendingBlockedPromptQueue = createPendingBlockedPromptQueue(turnResult, turnNumber);

        if (turnResult.exitCode !== 0) {
            this._done = true;
            throw new Error(`Agent exited with code ${turnResult.exitCode}`);
        }

        this._turn = turnNumber;
        this._lastMessage = response;
    }

    async hasFile(pattern: string): Promise<boolean> {
        const result = await this.deps.exec(`ls -d ${pattern} 2>/dev/null`);
        return result.stdout.trim().length > 0;
    }

    end(): void {
        this._done = true;
    }
}
