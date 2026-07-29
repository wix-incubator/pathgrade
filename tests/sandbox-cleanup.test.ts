import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { cleanupStaleSandboxes, SANDBOX_MARKER } from '../src/providers/sandbox-lifecycle.js';

const OLD = new Date(Date.now() - 25 * 60 * 60 * 1_000);

describe('cleanupStaleSandboxes', () => {
    let tempDir: string | undefined;

    afterEach(async () => {
        if (tempDir) await fs.remove(tempDir);
    });

    async function makeSandbox(name: string, options: { old?: boolean; pid?: number } = {}): Promise<string> {
        const root = path.join(tempDir!, name);
        await fs.ensureDir(root);
        const marker = path.join(root, SANDBOX_MARKER);
        await fs.writeFile(marker, JSON.stringify({ version: 1, pid: options.pid ?? 12345 }));
        if (options.old) await fs.utimes(marker, OLD, OLD);
        return root;
    }

    async function cleanup(options: Parameters<typeof cleanupStaleSandboxes>[0] = {}): Promise<void> {
        await cleanupStaleSandboxes({ tempDir, isProcessAlive: () => false, ...options });
    }

    it('deletes a stale owned sandbox', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-test-'));
        const stale = await makeSandbox('pathgrade-stale', { old: true });

        await cleanup();

        expect(await fs.pathExists(stale)).toBe(false);
    });

    it('preserves a recent sandbox and an old sandbox with a live owner', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-test-'));
        const recent = await makeSandbox('pathgrade-recent');
        const live = await makeSandbox('pathgrade-live', { old: true, pid: 999 });

        await cleanup({ isProcessAlive: (pid) => pid === 999 });

        expect(await fs.pathExists(recent)).toBe(true);
        expect(await fs.pathExists(live)).toBe(true);
    });

    it('preserves unrelated and unmarked PathGrade-looking directories', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-test-'));
        const unrelated = path.join(tempDir, 'other-tool');
        const unmarked = path.join(tempDir, 'pathgrade-not-a-sandbox');
        await fs.ensureDir(unrelated);
        await fs.ensureDir(unmarked);
        await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
        await fs.writeFile(path.join(unmarked, 'keep.txt'), 'keep');

        await cleanup();

        expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
        expect(await fs.readFile(path.join(unmarked, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('tolerates deletion races and failures without rejecting', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-test-'));
        const stale = await makeSandbox('pathgrade-racy', { old: true });
        const remove = vi.fn(async () => {
            throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        });

        await expect(cleanup({ remove })).resolves.toBeUndefined();
        expect(remove).toHaveBeenCalledWith(await fs.realpath(stale));
        expect(await fs.pathExists(stale)).toBe(true);
    });

    it('does not follow a PathGrade-named symlink outside the temp root', async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-test-'));
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-cleanup-outside-'));
        const link = path.join(tempDir, 'pathgrade-escape');
        try {
            await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
            await fs.symlink(outside, link);

            await cleanup();

            expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
            expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
        } finally {
            await fs.remove(outside);
        }
    });
});
