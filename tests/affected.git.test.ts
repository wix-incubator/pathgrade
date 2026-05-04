import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

// Bypass the vi.mock('child_process') below to get real bindings for the
// integration test and for the fixture setup commands (which must not go
// through the argv-based `git` wrapper).
const realRequire = createRequire(import.meta.url);
const realExecSync = realRequire('child_process').execSync as typeof import('child_process').execSync;
const realExecFileSync = realRequire('child_process').execFileSync as typeof import('child_process').execFileSync;

vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return {
        ...actual,
        execFileSync: vi.fn(actual.execFileSync),
    };
});

import { execFileSync } from 'child_process';
import { resolveBaseRef, computeChangedFiles } from '../src/affected/git.js';

const mockedExec = vi.mocked(execFileSync);

function makeExec(answers: Record<string, string | Error>) {
    mockedExec.mockImplementation((cmd: any, args?: any) => {
        const argv = Array.isArray(args) ? args : [];
        const key = `${String(cmd)} ${argv.join(' ')}`;
        for (const [pattern, answer] of Object.entries(answers)) {
            if (key.includes(pattern)) {
                if (answer instanceof Error) throw answer;
                return Buffer.from(answer) as any;
            }
        }
        throw new Error(`unexpected command: ${key}`);
    });
}

beforeEach(() => {
    mockedExec.mockReset();
});

describe('resolveBaseRef — PRD precedence', () => {
    it('precedence 1: GITHUB_BASE_REF → merge-base with origin/<base>', () => {
        makeExec({
            'merge-base refs/remotes/origin/main HEAD': 'abc123\n',
        });
        const result = resolveBaseRef({ GITHUB_BASE_REF: 'main' });
        expect(result).toEqual({ base: 'refs/remotes/origin/main', sha: 'abc123' });
    });

    it('precedence 2: GITHUB_EVENT_BEFORE when non-zero SHA', () => {
        const sha = 'def4567890abcdef1234567890abcdef12345678';
        const result = resolveBaseRef({ GITHUB_EVENT_BEFORE: sha });
        expect(result).toEqual({ base: sha, sha });
        expect(mockedExec).not.toHaveBeenCalled();
    });

    it('precedence 2: all-zero GITHUB_EVENT_BEFORE falls through to precedence 3', () => {
        makeExec({
            'merge-base HEAD origin/main': 'fallback1\n',
        });
        const result = resolveBaseRef({
            GITHUB_EVENT_BEFORE: '0000000000000000000000000000000000000000',
        });
        expect(result).toEqual({ base: 'origin/main', sha: 'fallback1' });
    });

    it('precedence 3 fallback: git merge-base HEAD origin/main', () => {
        makeExec({
            'merge-base HEAD origin/main': 'mainbase\n',
        });
        const result = resolveBaseRef({});
        expect(result).toEqual({ base: 'origin/main', sha: 'mainbase' });
    });

    it('falls back to origin/master when origin/main is unavailable', () => {
        makeExec({
            'merge-base HEAD origin/main': new Error('fatal: Not a valid object name'),
            'merge-base HEAD origin/master': 'masterbase\n',
        });
        const result = resolveBaseRef({});
        expect(result).toEqual({ base: 'origin/master', sha: 'masterbase' });
    });

    it('surfaces a remediation-style error when merge-base fails (shallow clone)', () => {
        makeExec({
            'merge-base HEAD origin/main': new Error('fatal: Not a valid object name'),
            'merge-base HEAD origin/master': new Error('fatal: Not a valid object name'),
        });
        const result = resolveBaseRef({});
        expect('error' in result).toBe(true);
        if ('error' in result) {
            expect(result.error).toMatch(/fetch-depth/);
            expect(result.error).toMatch(/actions\/checkout/);
        }
    });

    it('passes ref as an argv element, not shell-interpolated (execFileSync)', () => {
        const shellUnsafe = '$(echo pwned)';
        makeExec({
            [`merge-base refs/remotes/origin/${shellUnsafe} HEAD`]: 'abc123\n',
        });
        resolveBaseRef({ GITHUB_BASE_REF: shellUnsafe });
        // execFileSync must have been called with 'git' as command and an args array.
        const call = mockedExec.mock.calls[0];
        expect(call[0]).toBe('git');
        const argv = call[1] as unknown as string[];
        expect(Array.isArray(argv)).toBe(true);
        // The shell-unsafe substring must appear as a literal element, not parsed.
        expect(argv.some(a => a.includes(shellUnsafe))).toBe(true);
    });
});

describe('computeChangedFiles — three-dot diff', () => {
    it('uses --relative so paths are cwd-relative (monorepo safe)', () => {
        makeExec({
            'diff --relative --name-only abc123...HEAD': 'file1.ts\nfile2.ts\n',
        });
        const files = computeChangedFiles('abc123');
        expect(files).toEqual(['file1.ts', 'file2.ts']);
        // Verify the argv contains --relative
        const call = mockedExec.mock.calls[0];
        const argv = call[1] as unknown as string[];
        expect(argv).toContain('--relative');
    });

    it('trims and filters empty lines', () => {
        makeExec({
            'diff --relative --name-only abc123...HEAD': '\nfile1.ts\n\nfile2.ts\n\n',
        });
        expect(computeChangedFiles('abc123')).toEqual(['file1.ts', 'file2.ts']);
    });
});

// --- Integration: real git fixture repo ---
describe('git fixture — real divergent branch', () => {
    let tmpDir: string;
    const origCwd = process.cwd();

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-git-'));
        // Re-route the mocked execFileSync back to the real one for integration.
        mockedExec.mockImplementation(((...args: Parameters<typeof realExecFileSync>) =>
            realExecFileSync(...args)) as any);
    });

    afterEach(() => {
        process.chdir(origCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('computes the changed-files set between a base and HEAD via <base>...HEAD', () => {
        process.chdir(tmpDir);
        const run = (cmd: string) => realExecSync(cmd, { stdio: 'pipe', cwd: tmpDir });
        run('git init -q');
        run('git config user.email test@example.com');
        run('git config user.name test');
        run('git config commit.gpgsign false');
        fs.writeFileSync(path.join(tmpDir, 'base.txt'), 'base');
        run('git add -A');
        run('git commit -q -m base');
        const baseSha = realExecSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
        fs.writeFileSync(path.join(tmpDir, 'added.txt'), 'new');
        run('git add -A');
        run('git commit -q -m added');

        const files = computeChangedFiles(baseSha);
        expect(files).toEqual(['added.txt']);
    });
});
