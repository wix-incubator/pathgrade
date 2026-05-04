import type {
    AskUserReaction,
    Message,
    Reaction,
    ReactionPreviewEntry,
    ReactionPreviewResult,
    TextReaction,
} from './types.js';

function testRegExp(pattern: RegExp, input: string): boolean {
    const previousLastIndex = pattern.lastIndex;
    try {
        pattern.lastIndex = 0;
        return pattern.test(input);
    } finally {
        pattern.lastIndex = previousLastIndex;
    }
}

function testUnless(pattern: RegExp | undefined, input: string): boolean {
    if (!pattern) return false;
    try {
        return testRegExp(pattern, input);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`Reaction unless check failed: ${detail}`);
        return false;
    }
}

export function isAskUserReaction(reaction: Reaction): reaction is AskUserReaction {
    return 'whenAsked' in reaction;
}

export function isTextReaction(reaction: Reaction): reaction is TextReaction {
    return 'when' in reaction;
}

export function inspectReactions(
    agentMessage: string,
    reactions: Reaction[],
    firedOnce: Set<number>,
): ReactionPreviewEntry[] {
    let firedThisTurn = false;

    return reactions.map((reaction, reactionIndex): ReactionPreviewEntry => {
        if (isAskUserReaction(reaction)) {
            // Ask-user reactions are never evaluated against assistant free text.
            // They fire only on structured ask_user handshake turns (consumer in slice #4/#6).
            return {
                kind: 'ask_user',
                reactionIndex,
                whenAskedMatched: false,
                fired: false,
                status: 'no-match',
            };
        }

        if (reaction.once && firedOnce.has(reactionIndex)) {
            return {
                kind: 'text',
                reactionIndex,
                whenMatched: false,
                unlessMatched: false,
                fired: false,
                status: 'no-match',
            };
        }

        const whenMatched = testRegExp(reaction.when, agentMessage);
        const unlessMatched = whenMatched ? testUnless(reaction.unless, agentMessage) : false;
        const eligible = whenMatched && !unlessMatched;
        const fired = eligible && !firedThisTurn;

        if (fired && reaction.once) {
            firedOnce.add(reactionIndex);
        }
        if (fired) {
            firedThisTurn = true;
        }

        return {
            kind: 'text',
            reactionIndex,
            whenMatched,
            unlessMatched,
            fired,
            status: fired ? 'fired' : (unlessMatched ? 'vetoed' : 'no-match'),
            ...(fired ? { reply: reaction.reply } : {}),
        };
    });
}

export function pickReactionReply(
    agentMessage: string,
    reactions: Reaction[],
    firedOnce: Set<number>,
): string | null {
    const evaluations = inspectReactions(agentMessage, reactions, firedOnce);
    const match = evaluations.find((evaluation) => evaluation.fired && evaluation.kind === 'text');
    return match && match.kind === 'text' ? match.reply ?? null : null;
}

export function previewReactions(messages: Message[], reactions: Reaction[]): ReactionPreviewResult {
    const firedOnce = new Set<number>();
    const turns: ReactionPreviewResult['turns'] = [];
    let turn = 0;

    for (const message of messages) {
        if (message.role !== 'agent') continue;
        turn++;
        turns.push({
            turn,
            agentMessage: message.content,
            reactions: inspectReactions(message.content, reactions, firedOnce),
        });
    }

    return { turns };
}
