import * as fs from 'fs-extra';
import * as path from 'path';
import { ResolvedConversation } from './core/config.types';
import {
    AgentCommandRunner,
    BaseAgent,
    CommandExecutionOptions,
    ConversationReplySource,
    EnvironmentHandle,
    EnvironmentProvider,
    LogEntry,
    TrialResult,
    TurnCommand,
    createAgentSession,
    getWorkspacePath,
} from './types';

interface CompiledReply {
    content: string;
    when: RegExp;
}

interface ReplyPool {
    orderedQueue: string[];
    patternReplies: CompiledReply[];
}

interface ConversationRunOptions {
    agent: BaseAgent;
    conversation: ResolvedConversation;
    env?: Record<string, string>;
    provider: EnvironmentProvider;
    runtime: EnvironmentHandle;
    timeoutSec: number;
    timestamp: () => string;
}

export interface ConversationRunResult {
    commandCount: number;
    conversation: NonNullable<TrialResult['conversation']>;
    inputText: string;
    sessionLog: LogEntry[];
}

function withAbortTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        run(controller.signal).then(
            (val) => {
                clearTimeout(timer);
                if (timedOut || controller.signal.aborted) {
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
                    return;
                }
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                if (timedOut || controller.signal.aborted) {
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
                    return;
                }
                reject(err);
            }
        );
    });
}

function createReplyPool(conversation: ResolvedConversation): ReplyPool {
    return {
        orderedQueue: conversation.replies
            .filter((reply) => !reply.when)
            .map((reply) => reply.content),
        patternReplies: conversation.replies
            .filter((reply) => reply.when)
            .map((reply) => ({
                content: reply.content,
                when: new RegExp(reply.when!, 'i'),
            })),
    };
}

function normalizeAssistantMessage(rawOutput: string, assistantMessage?: string): string {
    const normalized = assistantMessage?.trim();
    if (normalized) {
        return normalized;
    }
    return rawOutput.trim();
}

function pickReply(
    assistantMessage: string,
    replyPool: ReplyPool
): { content: string; source: ConversationReplySource } | null {
    const patternIndex = replyPool.patternReplies.findIndex((reply) => reply.when.test(assistantMessage));
    if (patternIndex >= 0) {
        const [reply] = replyPool.patternReplies.splice(patternIndex, 1);
        return {
            content: reply.content,
            source: 'scripted_pattern',
        };
    }

    const orderedReply = replyPool.orderedQueue.shift();
    if (orderedReply) {
        return {
            content: orderedReply,
            source: 'scripted',
        };
    }

    return null;
}

async function workspaceHasSignal(workspacePath: string, signal: string): Promise<boolean> {
    if (!signal.includes('*')) {
        return await fs.pathExists(path.join(workspacePath, signal));
    }

    async function walk(dir: string): Promise<boolean> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absolutePath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (await walk(absolutePath)) {
                    return true;
                }
                continue;
            }

            const relativePath = path.relative(workspacePath, absolutePath).split(path.sep).join('/');
            if (path.matchesGlob(relativePath, signal)) {
                return true;
            }
        }
        return false;
    }

    return walk(workspacePath);
}

async function checkCompletion(
    assistantMessage: string,
    conversation: ResolvedConversation,
    runtime: EnvironmentHandle,
    turnNumber: number
): Promise<{ done: true; reason: NonNullable<TrialResult['conversation']>['completion_reason'] } | { done: false }> {
    if (conversation.completion.signal) {
        const workspacePath = getWorkspacePath(runtime);
        if (await workspaceHasSignal(workspacePath, conversation.completion.signal)) {
            return { done: true, reason: 'signal' };
        }
    }

    if (conversation.completion.done_phrase) {
        const donePattern = new RegExp(conversation.completion.done_phrase, 'i');
        if (donePattern.test(assistantMessage)) {
            return { done: true, reason: 'done_phrase' };
        }
    }

    if (turnNumber >= conversation.completion.max_turns) {
        return { done: true, reason: 'max_turns' };
    }

    return { done: false };
}

export async function runConversationTrial(opts: ConversationRunOptions): Promise<ConversationRunResult> {
    const sessionLog: LogEntry[] = [
        {
            type: 'agent_start',
            timestamp: opts.timestamp(),
            instruction: opts.conversation.opener,
        },
    ];
    const turns: NonNullable<TrialResult['conversation']>['turns'] = [];
    let commandCount = 0;
    const inputMessages: string[] = [];
    const replyPool = createReplyPool(opts.conversation);
    const deadlineMs = Date.now() + (opts.timeoutSec * 1000);
    let currentTurnNumber = 0;
    let currentTurnCommands: TurnCommand[] = [];
    let currentSignal: AbortSignal | undefined;

    const session = await createAgentSession(
        opts.agent,
        opts.runtime,
        async (cmd: string, commandOptions?: CommandExecutionOptions) => {
            const result = await opts.provider.runCommand(opts.runtime, cmd, opts.env, {
                ...commandOptions,
                signal: commandOptions?.signal ?? currentSignal,
            });
            commandCount++;
            currentTurnCommands.push({
                command: cmd,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                killed: result.killed,
            });
            sessionLog.push({
                type: 'command',
                timestamp: opts.timestamp(),
                command: cmd,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                turn_number: currentTurnNumber,
            });
            return result;
        }
    );

    let nextReply = {
        content: opts.conversation.opener,
        source: 'opener' as ConversationReplySource,
    };

    while (true) {
        const turnNumber = turns.length + 1;
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
            return {
                commandCount,
                conversation: {
                    turns,
                    total_turns: turns.length,
                    completion_reason: 'timeout',
                    timeout_triggered_at_turn: turnNumber,
                },
                inputText: inputMessages.join('\n\n'),
                sessionLog,
            };
        }

        const turnCommands: TurnCommand[] = [];
        currentTurnNumber = turnNumber;
        currentTurnCommands = turnCommands;
        const userMessage = nextReply.content;
        inputMessages.push(userMessage);
        sessionLog.push({
            type: 'user_reply',
            timestamp: opts.timestamp(),
            output: userMessage,
            turn_number: turnNumber,
            reply_source: nextReply.source,
        });

        const turnStart = Date.now();

        try {
            const turnResult = await withAbortTimeout(
                async (signal) => {
                    currentSignal = signal;
                    if (turnNumber === 1) {
                        return await session.start({ message: userMessage });
                    }
                    return await session.reply({ message: userMessage, continueSession: true });
                },
                remainingMs,
                `Conversation turn ${turnNumber}`
            );

            const assistantMessage = normalizeAssistantMessage(turnResult.rawOutput, turnResult.assistantMessage);
            const durationMs = Date.now() - turnStart;

            turns.push({
                turn_number: turnNumber,
                user_message: userMessage,
                user_message_source: nextReply.source,
                raw_agent_output: turnResult.rawOutput,
                assistant_message: assistantMessage,
                duration_ms: durationMs,
                commands: turnCommands,
                turn_status: 'completed',
            });

            sessionLog.push({
                type: 'agent_result',
                timestamp: opts.timestamp(),
                output: turnResult.rawOutput,
                assistant_message: assistantMessage,
                exitCode: turnResult.exitCode,
                turn_number: turnNumber,
            });

            const completion = await checkCompletion(
                assistantMessage,
                opts.conversation,
                opts.runtime,
                turnNumber
            );
            if (completion.done) {
                return {
                    commandCount,
                    conversation: {
                        turns,
                        total_turns: turns.length,
                        completion_reason: completion.reason,
                    },
                    inputText: inputMessages.join('\n\n'),
                    sessionLog,
                };
            }

            const reply = pickReply(assistantMessage, replyPool);
            if (!reply) {
                return {
                    commandCount,
                    conversation: {
                        turns,
                        total_turns: turns.length,
                        completion_reason: 'no_replies',
                    },
                    inputText: inputMessages.join('\n\n'),
                    sessionLog,
                };
            }

            nextReply = reply;
        } catch (err: any) {
            const durationMs = Date.now() - turnStart;
            const errorMessage = err?.message || String(err);
            const timedOut = errorMessage.includes('timed out after');

            turns.push({
                turn_number: turnNumber,
                user_message: userMessage,
                user_message_source: nextReply.source,
                raw_agent_output: '',
                assistant_message: '',
                duration_ms: durationMs,
                commands: turnCommands,
                turn_status: timedOut ? 'timeout' : 'error',
            });

            sessionLog.push({
                type: 'agent_result',
                timestamp: opts.timestamp(),
                output: errorMessage,
                assistant_message: '',
                turn_number: turnNumber,
            });

            return {
                commandCount,
                conversation: {
                    turns,
                    total_turns: turns.length,
                    completion_reason: timedOut ? 'timeout' : 'error',
                    timeout_triggered_at_turn: timedOut ? turnNumber : undefined,
                },
                inputText: inputMessages.join('\n\n'),
                sessionLog,
            };
        }
    }
}
