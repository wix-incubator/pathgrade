import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createAgent } from '../src/sdk/index.js';
import type { Agent } from '../src/sdk/types.js';

describe('debug workspace persistence', () => {
    let agent: Agent | undefined;
    const debugDirs: string[] = [];

    afterEach(async () => {
        if (agent) { await agent.dispose(); agent = undefined; }
        for (const dir of debugDirs) {
            await fs.remove(dir).catch(() => {});
        }
        debugDirs.length = 0;
    });

    it('debug: true copies workspace to pathgrade-debug next to eval file', async () => {
        agent = await createAgent({ debug: true });

        await fs.writeFile(path.join(agent.workspace, 'artifact.md'), '# Generated');

        // Debug dir should be next to this test file, not cwd
        const debugDir = path.join(__dirname, 'pathgrade-debug');
        debugDirs.push(debugDir);

        await agent.dispose();
        agent = undefined;

        // Should use slugified test name as subdirectory
        const expectedName = 'debug-true-copies-workspace-to-pathgrade-debug-next-to-eval-file';
        const copied = path.join(debugDir, expectedName, 'artifact.md');
        expect(await fs.pathExists(copied)).toBe(true);
        expect(await fs.readFile(copied, 'utf-8')).toBe('# Generated');
    });

    it('debug: string copies workspace to custom path', async () => {
        const customDest = path.join(os.tmpdir(), `pg-debug-custom-${Math.random().toString(36).slice(2)}`);
        debugDirs.push(customDest);

        agent = await createAgent({ debug: customDest });

        await fs.writeFile(path.join(agent.workspace, 'report.txt'), 'hello');

        await agent.dispose();
        agent = undefined;

        expect(await fs.pathExists(path.join(customDest, 'report.txt'))).toBe(true);
        expect(await fs.readFile(path.join(customDest, 'report.txt'), 'utf-8')).toBe('hello');
    });

    it('no debug option — workspace cleaned up, no debug dir created', async () => {
        agent = await createAgent({});

        const wsPath = agent.workspace;
        await fs.writeFile(path.join(wsPath, 'temp.txt'), 'gone');

        await agent.dispose();
        agent = undefined;

        // Workspace should be cleaned up
        expect(await fs.pathExists(wsPath)).toBe(false);
        // No debug directory should exist next to this test file
        const debugDir = path.join(__dirname, 'pathgrade-debug');
        expect(await fs.pathExists(debugDir)).toBe(false);
    });

    it('overwrites existing debug directory on re-run', async () => {
        const customDest = path.join(os.tmpdir(), `pg-debug-overwrite-${Math.random().toString(36).slice(2)}`);
        debugDirs.push(customDest);

        // Pre-populate with stale content
        await fs.ensureDir(customDest);
        await fs.writeFile(path.join(customDest, 'stale.txt'), 'old');

        agent = await createAgent({ debug: customDest });
        await fs.writeFile(path.join(agent.workspace, 'fresh.txt'), 'new');

        await agent.dispose();
        agent = undefined;

        expect(await fs.pathExists(path.join(customDest, 'fresh.txt'))).toBe(true);
        expect(await fs.readFile(path.join(customDest, 'fresh.txt'), 'utf-8')).toBe('new');
        // Stale file should be gone — overwrite, not merge
        expect(await fs.pathExists(path.join(customDest, 'stale.txt'))).toBe(false);
    });
});
