import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { sandboxExec } from '../src/providers/sandbox-exec.js';

describe('sandboxExec', () => {
    const dirs: string[] = [];
    const tmpDir = () => {
        const d = path.join(os.tmpdir(), `pg-exec-${Math.random().toString(36).slice(2)}`);
        dirs.push(d);
        return d;
    };

    afterEach(async () => {
        for (const d of dirs) await fs.remove(d).catch(() => {});
        dirs.length = 0;
    });

    it('runs a command and returns stdout + exitCode 0', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const result = await sandboxExec('echo hello', { cwd: dir, env: {} });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello');
        expect(result.stderr).toBe('');
    });

    it('returns non-zero exit code on failure', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const result = await sandboxExec('exit 42', { cwd: dir, env: {} });

        expect(result.exitCode).toBe(42);
    });

    it('captures stderr', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const result = await sandboxExec('echo oops >&2', { cwd: dir, env: {} });

        expect(result.stderr.trim()).toBe('oops');
        expect(result.exitCode).toBe(0);
    });

    it('aborts via signal (sends SIGTERM then SIGKILL after 250ms)', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const ac = new AbortController();
        const promise = sandboxExec('sleep 30', { cwd: dir, env: {} }, { signal: ac.signal });

        // Give the process a moment to start, then abort
        await new Promise((r) => setTimeout(r, 100));
        ac.abort();

        const result = await promise;
        expect(result.exitCode).toBe(124);
        expect(result.timedOut).toBe(true);
    });

    it('handles abort-before-spawn (signal already aborted)', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const ac = new AbortController();
        ac.abort(); // abort before calling sandboxExec

        const result = await sandboxExec('sleep 30', { cwd: dir, env: {} }, { signal: ac.signal });

        expect(result.exitCode).toBe(124);
        expect(result.timedOut).toBe(true);
    });

    it('uses cwd as working directory', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);
        await fs.writeFile(path.join(dir, 'marker.txt'), 'found-it');

        const result = await sandboxExec('cat marker.txt', { cwd: dir, env: {} });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('found-it');
    });

    it('passes env to child process', async () => {
        const dir = tmpDir();
        await fs.ensureDir(dir);

        const result = await sandboxExec(
            'echo $PG_TEST_VAR',
            { cwd: dir, env: { PG_TEST_VAR: 'sandbox-value', PATH: process.env.PATH ?? '' } },
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('sandbox-value');
    });
});
