import type { AgentTurnResult, LogEntry } from '../types.js';
import type {
    AgentName,
    AgentTransport,
    ConversationResult,
    ConverseOptions,
    EvalResult,
    Scorer,
    Message,
    TurnTiming,
    TurnDetail,
    ReactionFiredEntry,
} from './types.js';
import {
    buildAskBatchLogEntries,
    buildModelAgentResultLogEntry,
    buildSyntheticAgentResultLogEntry,
} from './agent-result-log.js';
import {
    advancePendingBlockedPromptQueue,
    createPendingBlockedPromptQueue,
    getBlockedPromptReplayLogMetadata,
    normalizeBlockedPromptReply,
    type PendingBlockedPromptQueue,
} from './blocked-prompt-queue.js';
import { inspectReactions } from './reaction-preview.js';
import { getVisibleAssistantMessage, normalizeTurnResult } from './visible-turn.js';
import type { VerboseEmitter } from '../reporters/verbose-emitter.js';
import type { AskBus } from './ask-bus/types.js';
import { createAskUserHandler } from './ask-bus/handler.js';
import { AgentCrashError } from './agent-crash.js';
import type { ToolEvent } from '../tool-events.js';

export interface ConversationDeps {
    /** Send a message to the agent, returns response string. Throws on failure. */
    sendTurn: (message: string) => Promise<string | AgentTurnResult>;
    /** Check file existence in workspace */
    hasFile: (pattern: string) => Promise<boolean>;
    /** Workspace path */
    workspace: string;
    /** Mutable messages array — runner appends user/agent entries */
    messages: Message[];
    /** Mutable log array */
    log: LogEntry[];
    /** Generate persona reply when no reaction matches */
    personaReply?: () => Promise<string>;
    /** Run step scorers */
    runStepScorers?: (scorers: Scorer[]) => Promise<EvalResult>;
    /** Verbose event sink (no-op when disabled) */
    verbose?: VerboseEmitter;
    /** Per-conversation ask-user bus. When omitted, ask_user reactions never fire. */
    askBus?: AskBus;
    /**
     * Resolved agent name. Surfaced for transport-aware preflight checks.
     */
    agentName?: AgentName;
    /**
     * Resolved transport (codex only). When `'exec'`, a preflight guard fails
     * fast at conversation start if any `AskUserReaction` is present without
     * `allowUnreachableReactions: true`.
     */
    transport?: AgentTransport;
}

function isTimeoutError(err: unknown): boolean {
    return err instanceof Error && /timed out/i.test(err.message);
}

export async function runConversation(
    opts: ConverseOptions,
    deps: ConversationDeps,
): Promise<ConversationResult> {
    const maxTurns = opts.maxTurns ?? 30;
    const reactions = opts.reactions ?? [];
    const stepScorers = opts.stepScorers ?? [];
    const firedOnce = new Set<number>();
    const stepResults: ConversationResult['stepResults'] = [];
    const turnTimings: TurnTiming[] = [];
    const turnDetails: TurnDetail[] = [];
    const reactionsFired: ReactionFiredEntry[] = [];
    let turn = 0;
    let pendingBlockedPromptQueue: PendingBlockedPromptQueue | null = null;
    const conversationStart = Date.now();

    const askUserHandlerApi = deps.askBus
        ? createAskUserHandler({
            reactions,
            onUnmatchedAskUser: opts.onUnmatchedAskUser ?? 'error',
            firedOnce,
        })
        : null;
    const unsubscribeAsk = askUserHandlerApi && deps.askBus
        ? deps.askBus.onAsk(askUserHandlerApi.handler)
        : null;

    const checkAskUserUnmatched = (): ConversationResult | null => {
        if (!askUserHandlerApi) return null;
        const err = askUserHandlerApi.getUnmatchedError();
        if (!err) return null;
        return buildResult(
            'error',
            `unmatched ask_user on turn ${err.turnNumber}: ${err.batchId}`,
        );
    };

    const MAX_TURN_RETRIES = 2;
    const RETRY_DELAY_MS = 2_000;

    const buildResult = (
        completionReason: ConversationResult['completionReason'],
        completionDetail?: string,
        crashDiagnostic?: ConversationResult['crashDiagnostic'],
    ): ConversationResult => {
        deps.log.push({
            type: 'conversation_end',
            timestamp: new Date().toISOString(),
            turn_number: turn,
            completion_reason: completionReason,
            completion_detail: completionDetail,
            turn_timings: turnTimings,
            turn_details: turnDetails,
            reactions_fired: reactionsFired,
        });
        deps.verbose?.conversationEnd({
            reason: completionReason,
            turns: turn,
            durationMs: Date.now() - conversationStart,
            ...(completionDetail ? { detail: completionDetail } : {}),
        });
        return {
            turns: turn,
            completionReason,
            completionDetail,
            turnTimings,
            turnDetails,
            reactionsFired,
            stepResults,
            ...(crashDiagnostic ? { crashDiagnostic } : {}),
        };
    };

    const buildCrashDiagnostic = (
        err: AgentCrashError,
    ): ConversationResult['crashDiagnostic'] => {
        const allAsks = deps.askBus?.snapshot() ?? [];
        const nonAskEvents: ToolEvent[] = (err.partialToolEvents ?? []).filter(
            (e) => e.action !== 'ask_user',
        );
        return {
            pid: err.pid,
            signal: err.signal ?? null,
            exitCode: err.exitCode ?? null,
            lastTurnNumber: turn,
            partialAsks: allAsks,
            partialToolEvents: nonAskEvents,
        };
    };

    // Send a message to the agent, update messages/log, return response.
    // Turn counter increments only after the agent responds successfully.
    // Retries transient agent errors (non-zero exit) up to MAX_TURN_RETRIES times.
    const isFirstTurn = () => turn === 0;
    const pushUserMessage = (message: string, kind: 'agent_start' | 'user_reply', turnNumber?: number): void => {
        deps.messages.push({ role: 'user', content: message });
        deps.log.push({
            type: kind,
            timestamp: new Date().toISOString(),
            instruction: message,
            ...(kind === 'user_reply' ? { turn_number: turnNumber } : {}),
        });
        deps.verbose?.turnStart({
            turn: turnNumber ?? turn + 1,
            kind,
            message,
        });
    };

    const pushModelAgentMessage = (
        response: string,
        turnNumber: number,
        durationMs: number,
        turnResult: AgentTurnResult,
    ): void => {
        turnTimings.push({ turn: turnNumber, durationMs });
        turnDetails.push({
            turn: turnNumber,
            durationMs,
            outputLines: response.split('\n').length,
            outputChars: response.length,
        });

        deps.messages.push({ role: 'agent', content: response });
        const timestamp = new Date().toISOString();
        if (deps.askBus) {
            for (const entry of buildAskBatchLogEntries({
                askBus: deps.askBus,
                turnNumber,
                timestamp,
            })) {
                deps.log.push(entry);
            }
        }
        deps.log.push(buildModelAgentResultLogEntry({
            timestamp,
            turnNumber,
            durationMs,
            turnResult,
            assistantMessage: response,
        }));
        for (const toolEvent of turnResult.toolEvents) {
            deps.verbose?.toolEvent({
                action: toolEvent.action,
                summary: toolEvent.summary,
            });
        }
        deps.verbose?.turnEnd({
            turn: turnNumber,
            durationMs,
            outputLines: response.split('\n').length,
            messagePreview: response,
        });
    };

    const pushSyntheticAgentMessage = (
        response: string,
        extraLogFields: Record<string, string | number | boolean | undefined>,
    ): void => {
        deps.messages.push({ role: 'agent', content: response });
        deps.log.push(buildSyntheticAgentResultLogEntry({
            timestamp: new Date().toISOString(),
            assistantMessage: response,
            extraFields: extraLogFields,
        }));
    };

    const emitActiveBlockedPrompt = (queue: PendingBlockedPromptQueue | null): void => {
        if (!queue) return;
        const prompt = queue.prompts[queue.activeIndex];
        deps.verbose?.blockedPrompt({
            sourceTool: prompt.sourceTool,
            promptIndex: prompt.order,
            promptCount: queue.prompts.length,
        });
    };

    const doModelTurn = async (
        message: string,
        options: { preLogged?: boolean; kind?: 'agent_start' | 'user_reply' } = {},
    ): Promise<string> => {
        if (!options.preLogged) {
            pushUserMessage(message, options.kind ?? (isFirstTurn() ? 'agent_start' : 'user_reply'), turn + 1);
        }

        const turnStart = Date.now();
        // Under app-server the child process holds thread state; a crashed
        // turn is not safely replayable, so retries are suppressed.
        const maxRetries = deps.transport === 'app-server' ? 0 : MAX_TURN_RETRIES;
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const turnResult = normalizeTurnResult(await deps.sendTurn(message));
                turn++;
                const response = getVisibleAssistantMessage(turnResult);
                const durationMs = Date.now() - turnStart;
                pendingBlockedPromptQueue = createPendingBlockedPromptQueue(turnResult, turn);
                pushModelAgentMessage(response, turn, durationMs, turnResult);
                emitActiveBlockedPrompt(pendingBlockedPromptQueue);
                return response;
            } catch (err) {
                lastError = err;
                // Don't retry timeouts — only transient agent errors
                if (isTimeoutError(err)) throw err;
                // Subprocess crashes bypass retries regardless of transport —
                // the error itself is the signal that replay is unsafe.
                if (err instanceof AgentCrashError) throw err;
                if (attempt < maxRetries) {
                    deps.log.push({
                        type: 'agent_result',
                        timestamp: new Date().toISOString(),
                        assistant_message: `[retry ${attempt + 1}/${maxRetries}] ${(err as Error).message}`,
                    });
                    deps.verbose?.retry({
                        attempt: attempt + 1,
                        maxAttempts: maxRetries,
                        errorMessage: (err as Error).message,
                    });
                    // Remove the user message we pushed so it gets re-pushed on retry
                    if (!options.preLogged) {
                        deps.messages.pop();
                    }
                    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
                    if (!options.preLogged) {
                        deps.messages.push({ role: 'user', content: message });
                    }
                }
            }
        }
        throw lastError;
    };

    try {
        // Preflight: transport 'exec' + AskUserReaction is unreachable. Fail fast
        // (before any turn runs) unless the caller opted out.
        if (
            deps.transport === 'exec'
            && !opts.allowUnreachableReactions
            && reactions.some((r) => 'whenAsked' in r)
        ) {
            return buildResult(
                'error',
                "AskUserReaction defined but transport is 'exec'; the handshake cannot fire under exec mode.",
            );
        }

        // Turn 1: send opener
        let agentMessage = await doModelTurn(opts.firstMessage, { kind: 'agent_start' });

        const unmatchedAfterOpener = checkAskUserUnmatched();
        if (unmatchedAfterOpener) return unmatchedAfterOpener;

        while (true) {
            // Check until predicate
            if (!pendingBlockedPromptQueue && opts.until) {
                const done = await opts.until({
                    turn,
                    lastMessage: agentMessage,
                    workspace: deps.workspace,
                    messages: deps.messages,
                    hasFile: deps.hasFile,
                });
                if (done) return buildResult('until');
            }

            // Check maxTurns
            if (!pendingBlockedPromptQueue && turn >= maxTurns) {
                return buildResult('maxTurns');
            }

            // Run step scorers scheduled for this turn
            if (!pendingBlockedPromptQueue) {
                for (const sg of stepScorers) {
                    if (sg.afterTurn === turn && deps.runStepScorers) {
                        const result = await deps.runStepScorers(sg.scorers);
                        stepResults.push({ afterTurn: sg.afterTurn, result });
                    }
                }
            }

            // Pick reply: reactions first, then persona fallback.
            // Only text-variant reactions fire from assistant free text; ask_user
            // reactions are handled by the bus subscription (slice #4).
            const reactionEvaluations = inspectReactions(agentMessage, reactions, firedOnce);
            const firedTextEvaluation = reactionEvaluations.find(
                (reaction) => reaction.fired && reaction.kind === 'text',
            );
            let reply: string | null = firedTextEvaluation && firedTextEvaluation.kind === 'text'
                ? firedTextEvaluation.reply ?? null
                : null;
            if (firedTextEvaluation && firedTextEvaluation.kind === 'text') {
                const firedReactionCfg = reactions[firedTextEvaluation.reactionIndex];
                const pattern = firedReactionCfg && 'when' in firedReactionCfg
                    ? String(firedReactionCfg.when)
                    : '';
                reactionsFired.push({
                    turn,
                    reactionIndex: firedTextEvaluation.reactionIndex,
                    pattern,
                    reply: firedTextEvaluation.reply ?? '',
                });
                deps.verbose?.reactionFired({
                    turn,
                    reactionIndex: firedTextEvaluation.reactionIndex,
                    pattern,
                    reply: firedTextEvaluation.reply ?? '',
                });
            }
            if (reply === null && deps.personaReply) {
                reply = await deps.personaReply();
            }
            if (reply === null) {
                return buildResult('noReply');
            }

            if (pendingBlockedPromptQueue) {
                reply = normalizeBlockedPromptReply(pendingBlockedPromptQueue, reply);
                const sourceTurn = pendingBlockedPromptQueue.sourceTurn;
                pushUserMessage(reply, 'user_reply', sourceTurn);
                const replay = advancePendingBlockedPromptQueue(pendingBlockedPromptQueue);
                pendingBlockedPromptQueue = replay.queue;
                if (replay.nextPromptMessage) {
                    agentMessage = replay.nextPromptMessage;
                    pushSyntheticAgentMessage(agentMessage, getBlockedPromptReplayLogMetadata(replay.queue!));
                    emitActiveBlockedPrompt(replay.queue);
                    continue;
                }
                if (turn >= maxTurns) {
                    return buildResult('maxTurns');
                }
                agentMessage = await doModelTurn(reply, { preLogged: true, kind: 'user_reply' });
                continue;
            }

            agentMessage = await doModelTurn(reply, { kind: 'user_reply' });

            const unmatched = checkAskUserUnmatched();
            if (unmatched) return unmatched;
        }
    } catch (err) {
        if (err instanceof AgentCrashError) {
            return buildResult('agent_crashed', err.message, buildCrashDiagnostic(err));
        }
        const reason = isTimeoutError(err) ? 'timeout' : 'error';
        const detail = err instanceof Error ? err.message : String(err);
        return buildResult(reason, detail);
    } finally {
        if (unsubscribeAsk) unsubscribeAsk();
    }
}

export { previewReactions } from './reaction-preview.js';
