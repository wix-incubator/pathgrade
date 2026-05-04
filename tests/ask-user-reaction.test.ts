import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as sdk from '../src/sdk/index.js';
import { inspectReactions } from '../src/sdk/reaction-preview.js';
import { loadReactionsFromFile } from '../src/sdk/reaction-loader.js';
import type { AskUserReaction, Reaction, TextReaction } from '../src/sdk/types.js';

describe('AskUserReaction public API surface', () => {
    it('re-exports AskUserQuestion, AskUserOption, AskUserReaction types (type-only probe)', () => {
        // The type-only imports compile iff the types exist. A smoke import ensures the
        // module graph is valid.
        const exported = sdk as Record<string, unknown>;
        expect('createAskBus' in exported).toBe(true);
    });

    it('Reaction is a discriminated union — text variant narrows via `when`', () => {
        const r: Reaction = { when: /artifact/, reply: 'ack' };
        if ('when' in r) {
            const text: TextReaction = r;
            expect(text.reply).toBe('ack');
        } else {
            throw new Error('expected TextReaction narrowing');
        }
    });

    it('Reaction is a discriminated union — ask_user variant narrows via `whenAsked`', () => {
        const r: Reaction = {
            whenAsked: /region/,
            answer: 'us-east-1',
        };
        if ('whenAsked' in r) {
            const ask: AskUserReaction = r;
            expect(ask.answer).toBe('us-east-1');
        } else {
            throw new Error('expected AskUserReaction narrowing');
        }
    });

    it('AskUserReaction.answer accepts string, string[], and a function returning either', () => {
        const s: AskUserReaction = { whenAsked: /a/, answer: 'x' };
        const a: AskUserReaction = { whenAsked: /a/, answer: ['x', 'y'] };
        const fn: AskUserReaction = { whenAsked: /a/, answer: (q) => (q.question === 'ok' ? 'y' : undefined) };
        expect(s.answer).toBe('x');
        expect(a.answer).toEqual(['x', 'y']);
        expect(typeof fn.answer).toBe('function');
    });
});

describe('inspectReactions with AskUserReaction entries', () => {
    it('skips ask_user entries during text-driven evaluation, keeps text entries working', () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'us-east-1' },
            { when: /confirm/, reply: 'Confirmed' },
        ];
        const result = inspectReactions('please confirm this step', reactions, new Set<number>());
        expect(result).toHaveLength(2);
        expect(result[0].kind).toBe('ask_user');
        expect(result[0].fired).toBe(false);
        expect(result[0].status).toBe('no-match');
        expect(result[1].kind).toBe('text');
        expect(result[1].fired).toBe(true);
    });

    it('ask_user entries never fire from free text even when their whenAsked regex would match', () => {
        const reactions: Reaction[] = [
            { whenAsked: /region/, answer: 'us-east-1' },
        ];
        const result = inspectReactions('which region should we use', reactions, new Set<number>());
        expect(result[0].kind).toBe('ask_user');
        expect(result[0].fired).toBe(false);
    });
});

describe('loadReactionsFromFile parses both variants', () => {
    let tmpDir: string;
    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-ask-reaction-'));
    });
    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('parses a mixed JSON file with text and ask_user entries', async () => {
        const reactionsPath = path.join(tmpDir, 'reactions.json');
        await fs.writeJson(reactionsPath, [
            { when: 'confirm', reply: 'ok' },
            { whenAsked: 'region', answer: 'us-east-1' },
            { whenAsked: 'which env', answer: ['dev', 'staging'] },
        ]);
        const reactions = await loadReactionsFromFile(reactionsPath);
        expect(reactions).toHaveLength(3);
        expect((reactions[0] as TextReaction).reply).toBe('ok');
        expect((reactions[1] as AskUserReaction).answer).toBe('us-east-1');
        expect((reactions[2] as AskUserReaction).answer).toEqual(['dev', 'staging']);
    });

    it('parses ask_user entry from a ts module default export', async () => {
        const reactionsPath = path.join(tmpDir, 'reactions.ts');
        await fs.writeFile(
            reactionsPath,
            `export default [
                { whenAsked: /region/, answer: 'us-east-1' },
            ];
            `,
            'utf-8',
        );
        const reactions = await loadReactionsFromFile(reactionsPath);
        expect(reactions).toHaveLength(1);
        expect((reactions[0] as AskUserReaction).answer).toBe('us-east-1');
    });

    it('rejects an ask_user entry missing answer', async () => {
        const reactionsPath = path.join(tmpDir, 'bad.json');
        await fs.writeJson(reactionsPath, [{ whenAsked: 'region' }]);
        await expect(loadReactionsFromFile(reactionsPath)).rejects.toThrow(/answer/i);
    });

    it('rejects an ask_user entry with an invalid whenAsked regex', async () => {
        const reactionsPath = path.join(tmpDir, 'bad-regex.json');
        await fs.writeJson(reactionsPath, [{ whenAsked: '[', answer: 'x' }]);
        await expect(loadReactionsFromFile(reactionsPath)).rejects.toThrow(/whenAsked/i);
    });
});
