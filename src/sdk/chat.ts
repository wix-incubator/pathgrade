import type { AgentTurnResult, CommandResult, LogEntry } from '../types.js';
import type { ChatSession, Message } from './types.js';
import { buildModelAgentResultLogEntry } from './agent-result-log.js';
import { getVisibleAssistantMessage } from './visible-turn.js';
import type { VerboseEmitter } from '../reporters/verbose-emitter.js';

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
    private deps: ChatSessionDeps;

    constructor(firstTurnResult: AgentTurnResult, deps: ChatSessionDeps) {
        this._turn = 1;
        this._lastMessage = getVisibleAssistantMessage(firstTurnResult);
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
        const turnNumber = this._turn + 1;

        this.deps.messages.push({ role: 'user', content: message });
        this.deps.log.push({
            type: 'user_reply',
            timestamp: timestamp(),
            instruction: message,
            turn_number: turnNumber,
        });
        this.deps.verbose?.turnStart({
            turn: turnNumber,
            kind: 'user_reply',
            message: message,
        });

        let turnResult: AgentTurnResult;
        const turnStart = Date.now();
        try {
            turnResult = await this.deps.sendTurn(message);
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
