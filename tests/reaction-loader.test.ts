import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message } from '../src/sdk/types.js';

async function loadReactionLoader() {
    return import('../src/sdk/' + 'reaction-loader');
}

function makeSnapshot(messages: Message[]) {
    return {
        version: 1,
        timestamp: '2026-04-07T00:00:00.000Z',
        agent: 'codex',
        messages,
        log: [],
        toolEvents: [],
        conversationResult: {
            turns: messages.filter((message) => message.role === 'agent').length,
            completionReason: 'maxTurns',
            turnTimings: [],
        },
        workspace: null,
    };
}

describe('reaction-loader', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-reaction-loader-'));
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('loads messages from a valid snapshot file', async () => {
        const loader = await loadReactionLoader();
        const snapshotPath = path.join(tmpDir, 'run-snapshot.json');
        const messages: Message[] = [
            { role: 'user', content: 'Start' },
            { role: 'agent', content: 'artifact available' },
        ];

        await fs.writeJson(snapshotPath, makeSnapshot(messages), { spaces: 2 });

        expect(loader.loadReactionSnapshotMessages).toBeTypeOf('function');
        if (typeof loader.loadReactionSnapshotMessages !== 'function') return;

        await expect(loader.loadReactionSnapshotMessages(snapshotPath)).resolves.toEqual(messages);
    });

    it('rejects malformed snapshots that do not contain a messages array', async () => {
        const loader = await loadReactionLoader();
        const snapshotPath = path.join(tmpDir, 'bad-snapshot.json');

        await fs.writeJson(snapshotPath, { version: 1, conversationResult: {} }, { spaces: 2 });

        expect(loader.loadReactionSnapshotMessages).toBeTypeOf('function');
        if (typeof loader.loadReactionSnapshotMessages !== 'function') return;

        await expect(loader.loadReactionSnapshotMessages(snapshotPath)).rejects.toThrow(/messages/i);
    });

    it('loads reactions from a ts module default export', async () => {
        const loader = await loadReactionLoader();
        const reactionsPath = path.join(tmpDir, 'reactions.ts');

        await fs.writeFile(
            reactionsPath,
            `export default [
                { when: /artifact available/, unless: /no artifact available/, reply: 'Ack', once: true },
            ];
            `,
            'utf-8',
        );

        expect(loader.loadReactionsFromFile).toBeTypeOf('function');
        if (typeof loader.loadReactionsFromFile !== 'function') return;

        await expect(loader.loadReactionsFromFile(reactionsPath)).resolves.toEqual([
            { when: /artifact available/, unless: /no artifact available/, reply: 'Ack', once: true },
        ]);
    });

    it('loads reactions from a js module named export', async () => {
        const loader = await loadReactionLoader();
        const reactionsPath = path.join(tmpDir, 'reactions.js');

        await fs.writeFile(
            reactionsPath,
            `exports.reactions = [
                { when: /confirm/, reply: 'Confirm' },
            ];
            `,
            'utf-8',
        );

        expect(loader.loadReactionsFromFile).toBeTypeOf('function');
        if (typeof loader.loadReactionsFromFile !== 'function') return;

        await expect(loader.loadReactionsFromFile(reactionsPath)).resolves.toEqual([
            { when: /confirm/, reply: 'Confirm' },
        ]);
    });

    it('loads reactions from json and compiles when/unless patterns', async () => {
        const loader = await loadReactionLoader();
        const reactionsPath = path.join(tmpDir, 'reactions.json');

        await fs.writeJson(
            reactionsPath,
            [
                {
                    when: 'artifact available',
                    unless: 'no artifact available',
                    reply: 'Ack',
                    once: true,
                },
            ],
            { spaces: 2 },
        );

        expect(loader.loadReactionsFromFile).toBeTypeOf('function');
        if (typeof loader.loadReactionsFromFile !== 'function') return;

        const reactions = await loader.loadReactionsFromFile(reactionsPath);
        expect(reactions).toHaveLength(1);
        expect(reactions[0].when).toBeInstanceOf(RegExp);
        expect(reactions[0].unless).toBeInstanceOf(RegExp);
        expect(reactions[0].when.test('artifact available')).toBe(true);
        expect(reactions[0].unless?.test('no artifact available')).toBe(true);
        expect(reactions[0].reply).toBe('Ack');
        expect(reactions[0].once).toBe(true);
    });

    it('rejects invalid reaction module shapes and invalid json regex patterns', async () => {
        const loader = await loadReactionLoader();
        const invalidModulePath = path.join(tmpDir, 'invalid-module.ts');
        const invalidJsonPath = path.join(tmpDir, 'invalid-reactions.json');

        await fs.writeFile(invalidModulePath, 'export default { nope: true };', 'utf-8');
        await fs.writeJson(
            invalidJsonPath,
            [{ when: '[', reply: 'broken regex' }],
            { spaces: 2 },
        );

        expect(loader.loadReactionsFromFile).toBeTypeOf('function');
        if (typeof loader.loadReactionsFromFile !== 'function') return;

        await expect(loader.loadReactionsFromFile(invalidModulePath)).rejects.toThrow(/reactions/i);
        await expect(loader.loadReactionsFromFile(invalidJsonPath)).rejects.toThrow(/invalid.*when/i);
    });
});
