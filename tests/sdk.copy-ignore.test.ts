import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createAgent, DEFAULT_COPY_IGNORE } from '../src/sdk/index.js';
import type { Agent } from '../src/sdk/types.js';

describe('SDK copyIgnore', () => {
    let agent: Agent | undefined;
    const fixtureDirs: string[] = [];

    afterEach(async () => {
        if (agent) {
            await agent.dispose();
            agent = undefined;
        }
        for (const fixtureDir of fixtureDirs) {
            await fs.remove(fixtureDir).catch(() => {});
        }
        fixtureDirs.length = 0;
    });

    it('re-exports DEFAULT_COPY_IGNORE from the SDK entrypoint', () => {
        expect(DEFAULT_COPY_IGNORE).toEqual([
            'node_modules',
            '.git',
            'dist',
            '.DS_Store',
            '__pycache__',
            'npm-debug.log*',
            'yarn-debug.log*',
            'yarn-error.log*',
        ]);
    });

    it('does not allow consumers to mutate DEFAULT_COPY_IGNORE', () => {
        const original = [...DEFAULT_COPY_IGNORE];

        expect(() => {
            (DEFAULT_COPY_IGNORE as string[]).push('unexpected');
        }).toThrow();
        expect(DEFAULT_COPY_IGNORE).toEqual(original);
    });

    it('threads copyIgnore from createAgent into workspace preparation', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-sdk-copy-ignore-${Math.random().toString(36).slice(2)}`);
        fixtureDirs.push(fixtureDir);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'keep.ts'), 'export const keep = true;');
        await fs.writeFile(path.join(fixtureDir, 'custom.tmp'), 'remove me');

        agent = await createAgent({
            workspace: fixtureDir,
            copyIgnore: ['custom.tmp'],
        });

        expect(await fs.pathExists(path.join(agent.workspace, 'keep.ts'))).toBe(true);
        expect(await fs.pathExists(path.join(agent.workspace, 'custom.tmp'))).toBe(false);
    });

    it('uses the default ignore list when copyIgnore is omitted', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-sdk-copy-ignore-${Math.random().toString(36).slice(2)}`);
        fixtureDirs.push(fixtureDir);
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'left-pad'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(fixtureDir, 'keep.ts'), 'export const keep = true;');

        agent = await createAgent({
            workspace: fixtureDir,
        });

        expect(await fs.pathExists(path.join(agent.workspace, 'keep.ts'))).toBe(true);
        expect(await fs.pathExists(path.join(agent.workspace, 'node_modules'))).toBe(false);
    });
});
