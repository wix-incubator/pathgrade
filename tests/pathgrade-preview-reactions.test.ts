import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { buildRunSnapshot } from '../src/sdk/index.js';
import { runPreviewReactions } from '../src/commands/preview-reactions.js';

describe('runPreviewReactions', () => {
    const tempPaths: string[] = [];

    afterEach(async () => {
        for (const tempPath of tempPaths) {
            await fs.remove(tempPath).catch(() => {});
        }
        tempPaths.length = 0;
    });

    it('loads reactions from JSON and prints machine-readable output', async () => {
        const dir = path.join(os.tmpdir(), `pg-preview-reactions-json-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(dir);
        await fs.ensureDir(dir);

        const snapshotPath = path.join(dir, 'run-snapshot.json');
        const reactionsPath = path.join(dir, 'reactions.json');
        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages: [
                { role: 'user', content: 'Start' },
                { role: 'agent', content: 'confirm later' },
                { role: 'user', content: 'Next' },
                { role: 'agent', content: 'confirm now' },
            ],
            log: [],
            conversationResult: {
                turns: 2,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }, { turn: 2, durationMs: 12 }],
                stepResults: [],
            },
            workspace: dir,
        }), { spaces: 2 });
        await fs.writeJSON(reactionsPath, [
            { when: 'confirm', unless: 'later', reply: 'Confirmed', once: true },
            { when: 'done', reply: 'Done' },
        ], { spaces: 2 });

        const chunks: string[] = [];
        const exitCode = await runPreviewReactions({
            snapshot: snapshotPath,
            reactions: reactionsPath,
            format: 'json',
            write: (chunk) => chunks.push(chunk),
        });

        expect(exitCode).toBe(0);
        const preview = JSON.parse(chunks.join(''));
        expect(preview.turns[0].reactions[0].status).toBe('vetoed');
        expect(preview.turns[1].reactions[0].status).toBe('fired');
    });

    it('loads reactions from a TS module and prints CLI rows', async () => {
        const dir = path.join(os.tmpdir(), `pg-preview-reactions-ts-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(dir);
        await fs.ensureDir(dir);

        const snapshotPath = path.join(dir, 'run-snapshot.json');
        const reactionsPath = path.join(dir, 'reactions.ts');
        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages: [
                { role: 'user', content: 'Start' },
                { role: 'agent', content: 'confirm now' },
            ],
            log: [],
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }],
                stepResults: [],
            },
            workspace: dir,
        }), { spaces: 2 });
        await fs.writeFile(
            reactionsPath,
            "export const reactions = [{ when: /confirm/i, reply: 'Confirmed' }];\n",
        );

        const chunks: string[] = [];
        const exitCode = await runPreviewReactions({
            snapshot: snapshotPath,
            reactions: reactionsPath,
            format: 'cli',
            write: (chunk) => chunks.push(chunk),
        });

        expect(exitCode).toBe(0);
        const output = chunks.join('');
        expect(output).toContain('Turn');
        expect(output).toContain('confirm now');
        expect(output).toContain('fired');
    });
});
