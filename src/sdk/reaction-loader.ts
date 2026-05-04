import fs from 'fs-extra';
import * as path from 'path';
import createJiti from 'jiti';
import type {
    AskUserOption,
    AskUserQuestion,
    AskUserReaction,
    Message,
    Reaction,
    TextReaction,
} from './types.js';

type JsonReactionLike = {
    when?: unknown;
    unless?: unknown;
    reply?: unknown;
    once?: unknown;
    whenAsked?: unknown;
    answer?: unknown;
};

function isMessage(value: unknown): value is Message {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return (candidate.role === 'user' || candidate.role === 'agent') && typeof candidate.content === 'string';
}

function compilePattern(pattern: string, fieldName: 'when' | 'unless' | 'whenAsked', source: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${fieldName} pattern in ${source}: ${detail}`);
    }
}

function toTextReaction(value: JsonReactionLike, source: string): TextReaction {
    if (!(value.when instanceof RegExp) && typeof value.when !== 'string') {
        throw new Error(`Text reaction entry in ${source} must define a RegExp or string "when" pattern.`);
    }
    if (typeof value.reply !== 'string') {
        throw new Error(`Text reaction entry in ${source} must define a string "reply".`);
    }
    if (value.unless !== undefined && !(value.unless instanceof RegExp) && typeof value.unless !== 'string') {
        throw new Error(`Text reaction entry in ${source} must define a RegExp or string "unless" pattern when present.`);
    }
    if (value.once !== undefined && typeof value.once !== 'boolean') {
        throw new Error(`Text reaction entry in ${source} must define a boolean "once" flag when present.`);
    }

    return {
        when: value.when instanceof RegExp ? value.when : compilePattern(value.when, 'when', source),
        ...(value.unless === undefined
            ? {}
            : {
                unless: value.unless instanceof RegExp
                    ? value.unless
                    : compilePattern(value.unless, 'unless', source),
            }),
        reply: value.reply,
        ...(value.once === undefined ? {} : { once: value.once }),
    };
}

function toAskUserReaction(value: JsonReactionLike, source: string): AskUserReaction {
    const whenAsked = value.whenAsked;
    const answer = value.answer;

    if (!(whenAsked instanceof RegExp) && typeof whenAsked !== 'string' && typeof whenAsked !== 'function') {
        throw new Error(`Ask-user reaction entry in ${source} must define a RegExp, string, or function "whenAsked".`);
    }
    if (typeof answer !== 'string' && !Array.isArray(answer) && typeof answer !== 'function') {
        throw new Error(`Ask-user reaction entry in ${source} must define a string, string[], or function "answer".`);
    }
    if (Array.isArray(answer) && !answer.every((x) => typeof x === 'string')) {
        throw new Error(`Ask-user reaction entry in ${source} "answer" array must contain only strings.`);
    }
    if (value.once !== undefined && typeof value.once !== 'boolean') {
        throw new Error(`Ask-user reaction entry in ${source} must define a boolean "once" flag when present.`);
    }

    const compiledWhenAsked: AskUserReaction['whenAsked'] =
        whenAsked instanceof RegExp
            ? whenAsked
            : typeof whenAsked === 'function'
                ? (whenAsked as (q: AskUserQuestion) => boolean)
                : compilePattern(whenAsked, 'whenAsked', source);

    return {
        whenAsked: compiledWhenAsked,
        answer: answer as AskUserReaction['answer'],
        ...(value.once === undefined ? {} : { once: value.once }),
    };
}

function toReaction(value: unknown, source: string): Reaction {
    if (!value || typeof value !== 'object') {
        throw new Error(`Reaction entry in ${source} must be an object.`);
    }

    const reaction = value as JsonReactionLike;
    const hasWhen = reaction.when !== undefined;
    const hasWhenAsked = reaction.whenAsked !== undefined;

    if (hasWhen && hasWhenAsked) {
        throw new Error(`Reaction entry in ${source} must not define both "when" and "whenAsked".`);
    }
    if (hasWhenAsked) {
        return toAskUserReaction(reaction, source);
    }
    return toTextReaction(reaction, source);
}

function extractReactionList(moduleExports: unknown, source: string): unknown[] {
    if (Array.isArray(moduleExports)) return moduleExports;
    if (moduleExports && typeof moduleExports === 'object') {
        const record = moduleExports as Record<string, unknown>;
        if (Array.isArray(record.default)) return record.default;
        if (Array.isArray(record.reactions)) return record.reactions;
    }

    throw new Error(
        `Reaction file ${source} must export an array directly, as a default export, or as a named "reactions" export.`,
    );
}

export async function loadReactionSnapshotMessages(snapshotPath: string): Promise<Message[]> {
    const resolvedPath = path.resolve(snapshotPath);
    const snapshot = await fs.readJson(resolvedPath);

    if (!Array.isArray(snapshot.messages) || !snapshot.messages.every(isMessage)) {
        throw new Error(`Snapshot ${resolvedPath} must contain a valid messages array.`);
    }

    return snapshot.messages;
}

export async function loadReactionsFromFile(filePath: string): Promise<Reaction[]> {
    const resolvedPath = path.resolve(filePath);
    const extension = path.extname(resolvedPath).toLowerCase();

    if (extension === '.json') {
        const json = await fs.readJson(resolvedPath);
        if (!Array.isArray(json)) {
            throw new Error(`Reaction JSON ${resolvedPath} must contain an array.`);
        }
        return json.map((entry, index) => toReaction(entry, `${resolvedPath}#${index}`));
    }

    const jiti = createJiti(__filename, { moduleCache: false, interopDefault: false });
    const loaded = jiti(resolvedPath);
    return extractReactionList(loaded, resolvedPath).map((entry, index) =>
        toReaction(entry, `${resolvedPath}#${index}`),
    );
}

export type { AskUserOption, AskUserQuestion, AskUserReaction, TextReaction };
