import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock the git helper so the affected command's auto-detection path is
// exercised without touching the real git repo.
vi.mock('../src/affected/git.js', () => ({
    resolveBaseRef: vi.fn(),
    computeChangedFiles: vi.fn(),
}));

import { runAffected } from '../src/commands/affected.js';
import { resolveBaseRef, computeChangedFiles } from '../src/affected/git.js';

const mockedResolve = vi.mocked(resolveBaseRef);
const mockedChanged = vi.mocked(computeChangedFiles);

const MONOREPO = path.resolve(__dirname, 'fixtures/affected/monorepo');

function captureStd() {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any) => {
        out.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
        return true;
    };
    (process.stderr as any).write = (chunk: any) => {
        err.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
        return true;
    };
    return {
        stdout: () => out.join(''),
        stderr: () => err.join(''),
        restore: () => {
            process.stdout.write = origOut;
            process.stderr.write = origErr;
        },
    };
}

describe('runAffected (pathgrade affected command)', () => {
    let changedFilesPath: string;

    beforeEach(() => {
        changedFilesPath = path.join(os.tmpdir(), `pathgrade-changed-${Date.now()}-${Math.random()}.txt`);
        mockedResolve.mockReset();
        mockedChanged.mockReset();
    });

    it('prints selected eval paths one-per-line to stdout (sorted)', async () => {
        fs.writeFileSync(changedFilesPath, 'skills/alpha/src/foo.ts\nskills/beta/src/bar.ts\n');

        const cap = captureStd();
        try {
            const code = await runAffected({
                cwd: MONOREPO,
                changedFilesPath,
            });
            cap.restore();
            expect(code).toBe(0);
            const stdout = cap.stdout().trim().split('\n');
            expect(stdout).toEqual([
                'skills/alpha/test/alpha.eval.ts',
                'skills/beta/test/beta.eval.ts',
            ]);
        } finally {
            cap.restore();
            fs.unlinkSync(changedFilesPath);
        }
    });

    it('empty changed-files file → empty stdout, exit 0', async () => {
        fs.writeFileSync(changedFilesPath, '');

        const cap = captureStd();
        try {
            const code = await runAffected({
                cwd: MONOREPO,
                changedFilesPath,
            });
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout().trim()).toBe('');
        } finally {
            cap.restore();
            try { fs.unlinkSync(changedFilesPath); } catch {}
        }
    });

    it('auto-derives via git when no flags provided and prints base-ref one-liner to stderr', async () => {
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        // A change under alpha triggers alpha directly, and beta via its
        // extraDeps → both evals run.
        mockedChanged.mockReturnValue(['skills/alpha/src/x.ts']);

        const cap = captureStd();
        try {
            const code = await runAffected({ cwd: MONOREPO });
            cap.restore();
            expect(code).toBe(0);
            const lines = cap.stdout().trim().split('\n').sort();
            expect(lines).toEqual([
                'skills/alpha/test/alpha.eval.ts',
                'skills/beta/test/beta.eval.ts',
            ]);
            expect(cap.stderr()).toContain('base = origin/main@abc1234');
        } finally {
            cap.restore();
        }
    });

    it('git auto-detect failure surfaces remediation to stderr and exits 1', async () => {
        mockedResolve.mockReturnValue({
            error: 'pathgrade: merge-base resolution failed — ensure the `actions/checkout` step has `fetch-depth: 0`',
        });

        const cap = captureStd();
        try {
            const code = await runAffected({ cwd: MONOREPO });
            cap.restore();
            expect(code).toBe(1);
            expect(cap.stderr()).toMatch(/fetch-depth/);
        } finally {
            cap.restore();
        }
    });

    it('--since=<ref> overrides auto-detection', async () => {
        mockedResolve.mockImplementation(() => {
            throw new Error('resolveBaseRef should not be called with --since');
        });
        mockedChanged.mockReturnValue(['skills/alpha/src/x.ts']);

        const cap = captureStd();
        try {
            const code = await runAffected({ cwd: MONOREPO, since: 'HEAD~3' });
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout()).toContain('skills/alpha/test/alpha.eval.ts');
            expect(mockedChanged).toHaveBeenCalledWith('HEAD~3');
        } finally {
            cap.restore();
        }
    });

    it('--changed-files takes precedence over --since and auto', async () => {
        fs.writeFileSync(changedFilesPath, 'skills/beta/src/x.ts\n');
        mockedResolve.mockImplementation(() => {
            throw new Error('should not run');
        });

        const cap = captureStd();
        try {
            const code = await runAffected({
                cwd: MONOREPO,
                since: 'HEAD~3',
                changedFilesPath,
            });
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout().trim()).toBe('skills/beta/test/beta.eval.ts');
            expect(mockedChanged).not.toHaveBeenCalled();
        } finally {
            cap.restore();
            try { fs.unlinkSync(changedFilesPath); } catch {}
        }
    });

    it('unreadable --changed-files path → error and exit 1', async () => {
        const cap = captureStd();
        try {
            const code = await runAffected({
                cwd: MONOREPO,
                changedFilesPath: '/nonexistent/path/to/file.txt',
            });
            cap.restore();
            expect(code).toBe(1);
            expect(cap.stderr().toLowerCase()).toContain('changed-files');
        } finally {
            cap.restore();
        }
    });
});
