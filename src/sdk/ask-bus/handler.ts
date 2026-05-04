import type {
    AskAnswer,
    AskBatch,
    AskHandler,
    AskQuestion,
    AskResolution,
} from './types.js';
import type {
    AskUserQuestion,
    AskUserReaction,
    AskUserReactionPreviewEntry,
    Reaction,
} from '../types.js';

export type UnmatchedAskUserDisposition = 'error' | 'first-option' | 'decline';

export interface AskUserHandlerContext {
    reactions: readonly Reaction[];
    onUnmatchedAskUser: UnmatchedAskUserDisposition;
    firedOnce: Set<number>;
}

export interface AskUserUnmatchedSignal {
    batchId: string;
    turnNumber: number;
}

export interface AskUserHandlerApi {
    readonly handler: AskHandler;
    /** Preview entries recorded per batchId (live AND post-hoc). */
    readonly previewByBatch: Map<string, AskUserReactionPreviewEntry[]>;
    /**
     * Set when a live batch falls through to `onUnmatchedAskUser: 'error'`.
     * Caller inspects after each turn and ends the conversation with
     * `completionReason: 'error'`.
     */
    getUnmatchedError(): AskUserUnmatchedSignal | null;
}

function isAskUserReaction(reaction: Reaction): reaction is AskUserReaction {
    return 'whenAsked' in reaction;
}

function toAskUserQuestion(q: AskQuestion): AskUserQuestion {
    return {
        id: q.id,
        header: q.header,
        question: q.question,
        isOther: q.isOther,
        isSecret: q.isSecret,
        options: q.options === null ? null : q.options.map((o) => ({ ...o })),
    };
}

function matchesWhenAsked(reaction: AskUserReaction, question: AskUserQuestion): boolean {
    if (reaction.whenAsked instanceof RegExp) {
        const rx = reaction.whenAsked;
        const previousLastIndex = rx.lastIndex;
        try {
            rx.lastIndex = 0;
            return rx.test(question.question);
        } finally {
            rx.lastIndex = previousLastIndex;
        }
    }
    return reaction.whenAsked(question);
}

function normalizeAnswer(raw: string | string[] | undefined): string[] | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') return [raw];
    return [...raw];
}

function callReactionAnswer(
    reaction: AskUserReaction,
    question: AskUserQuestion,
): string[] | undefined {
    if (typeof reaction.answer === 'function') {
        // Authoring-bug throws propagate intentionally.
        const raw = reaction.answer(question);
        return normalizeAnswer(raw);
    }
    return normalizeAnswer(reaction.answer);
}

interface ReactionResolution {
    reactionIndex: number;
    values: string[];
}

function tryReactionsForQuestion(
    question: AskUserQuestion,
    reactions: readonly Reaction[],
    firedOnce: Set<number>,
    shadowedByQuestion: Map<string, Set<number>>,
): ReactionResolution | undefined {
    let primary: ReactionResolution | undefined;
    for (let reactionIndex = 0; reactionIndex < reactions.length; reactionIndex++) {
        const reaction = reactions[reactionIndex];
        if (!isAskUserReaction(reaction)) continue;
        if (reaction.once && firedOnce.has(reactionIndex)) continue;
        if (!matchesWhenAsked(reaction, question)) continue;

        const values = callReactionAnswer(reaction, question);
        if (values === undefined) continue;

        if (!primary) {
            primary = { reactionIndex, values };
        } else {
            let set = shadowedByQuestion.get(question.id);
            if (!set) {
                set = new Set<number>();
                shadowedByQuestion.set(question.id, set);
            }
            set.add(reactionIndex);
        }
    }
    return primary;
}

function applyFallback(
    question: AskUserQuestion,
    disposition: UnmatchedAskUserDisposition,
): { answer: AskAnswer; unmatched: boolean } {
    if (disposition === 'decline') {
        return {
            answer: { questionId: question.id, values: [], source: 'declined' },
            unmatched: false,
        };
    }
    if (disposition === 'first-option') {
        if (question.isSecret) {
            return {
                answer: { questionId: question.id, values: [], source: 'declined' },
                unmatched: true,
            };
        }
        if (question.options && question.options.length > 0) {
            return {
                answer: {
                    questionId: question.id,
                    values: [question.options[0].label],
                    source: 'fallback',
                },
                unmatched: false,
            };
        }
        // No options — degrades to 'error'.
        return {
            answer: { questionId: question.id, values: [], source: 'declined' },
            unmatched: true,
        };
    }
    // 'error' — respond declined so the handle resolves; caller ends the turn.
    return {
        answer: { questionId: question.id, values: [], source: 'declined' },
        unmatched: true,
    };
}

export function createAskUserHandler(ctx: AskUserHandlerContext): AskUserHandlerApi {
    const previewByBatch = new Map<string, AskUserReactionPreviewEntry[]>();
    let unmatchedError: AskUserUnmatchedSignal | null = null;

    const buildPreviewEntries = (
        batch: AskBatch,
        firedReactionIndexes: Set<number>,
        shadowedIndexes: Set<number>,
        resolvedAnswersByReaction: Map<number, string[]>,
    ): AskUserReactionPreviewEntry[] => {
        const entries: AskUserReactionPreviewEntry[] = [];
        for (let reactionIndex = 0; reactionIndex < ctx.reactions.length; reactionIndex++) {
            const reaction = ctx.reactions[reactionIndex];
            if (!isAskUserReaction(reaction)) continue;

            const fired = firedReactionIndexes.has(reactionIndex);
            const shadowed = shadowedIndexes.has(reactionIndex);
            const whenAskedMatched = fired || shadowed
                || batch.questions.some((q) => matchesWhenAsked(reaction, toAskUserQuestion(q)));

            let status: AskUserReactionPreviewEntry['status'];
            if (fired) status = 'fired';
            else if (shadowed) status = 'shadowed';
            else status = 'no-match';

            const entry: AskUserReactionPreviewEntry = {
                kind: 'ask_user',
                reactionIndex,
                whenAskedMatched,
                fired,
                status,
            };
            if (fired) {
                const values = resolvedAnswersByReaction.get(reactionIndex);
                if (values !== undefined) entry.resolvedAnswers = [...values];
            }
            entries.push(entry);
        }
        return entries;
    };

    const handler: AskHandler = (batch, respond) => {
        const answers: AskAnswer[] = [];
        const firedReactionIndexes = new Set<number>();
        const shadowedByQuestion = new Map<string, Set<number>>();
        const resolvedAnswersByReaction = new Map<number, string[]>();
        const firedOnceThisBatch = new Set<number>();
        let anyUnmatched = false;

        for (const rawQuestion of batch.questions) {
            const question = toAskUserQuestion(rawQuestion);
            const currentFired = new Set(ctx.firedOnce);
            for (const idx of firedOnceThisBatch) currentFired.add(idx);

            const reactionHit = tryReactionsForQuestion(
                question,
                ctx.reactions,
                currentFired,
                shadowedByQuestion,
            );

            if (reactionHit) {
                answers.push({
                    questionId: question.id,
                    values: reactionHit.values,
                    source: 'reaction',
                });
                firedReactionIndexes.add(reactionHit.reactionIndex);
                resolvedAnswersByReaction.set(reactionHit.reactionIndex, reactionHit.values);
                const reaction = ctx.reactions[reactionHit.reactionIndex];
                if (isAskUserReaction(reaction) && reaction.once) {
                    firedOnceThisBatch.add(reactionHit.reactionIndex);
                }
                continue;
            }

            const fallback = applyFallback(question, ctx.onUnmatchedAskUser);
            answers.push(fallback.answer);
            if (fallback.unmatched) anyUnmatched = true;
        }

        // Commit once-retirement after batch completes (global across conversation).
        for (const idx of firedOnceThisBatch) ctx.firedOnce.add(idx);

        const shadowedIndexes = new Set<number>();
        for (const set of shadowedByQuestion.values()) {
            for (const idx of set) shadowedIndexes.add(idx);
        }

        previewByBatch.set(
            batch.batchId,
            buildPreviewEntries(
                batch,
                firedReactionIndexes,
                shadowedIndexes,
                resolvedAnswersByReaction,
            ),
        );

        if (batch.lifecycle === 'post-hoc') {
            // Observability only — bus drops any respond() call at the wire.
            return;
        }

        const resolution: AskResolution = { answers };
        respond(resolution);

        if (anyUnmatched && ctx.onUnmatchedAskUser === 'error') {
            unmatchedError = { batchId: batch.batchId, turnNumber: batch.turnNumber };
        } else if (anyUnmatched && ctx.onUnmatchedAskUser === 'first-option') {
            // 'first-option' falls through to 'error' when no options / isSecret.
            unmatchedError = { batchId: batch.batchId, turnNumber: batch.turnNumber };
        }
    };

    return {
        handler,
        previewByBatch,
        getUnmatchedError: () => unmatchedError,
    };
}
