import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/affected/git.js', () => ({
    resolveBaseRef: vi.fn(),
    computeChangedFiles: vi.fn(),
}));

import { runChanged, type SpawnVitest } from '../src/commands/run-changed.js';
import { resolveBaseRef, computeChangedFiles } from '../src/affected/git.js';

const mockedResolve = vi.mocked(resolveBaseRef);
const mockedChanged = vi.mocked(computeChangedFiles);

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

function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-runchanged-'));
    const w = (rel: string, c: string) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, c);
    };
    w('skills/alpha/SKILL.md', '# a');
    w('skills/alpha/a.eval.ts', 'export {};\n');
    w('skills/beta/SKILL.md', '# b');
    w('skills/beta/b.eval.ts', 'export {};\n');
    return root;
}

describe('runChanged — pathgrade run --changed orchestration', () => {
    let fakeSpawn: ReturnType<typeof vi.fn> & SpawnVitest;

    beforeEach(() => {
        mockedResolve.mockReset();
        mockedChanged.mockReset();
        fakeSpawn = vi.fn<SpawnVitest>(() => 0) as any;
    });

    it('computes selection then spawns vitest with the selected file list', async () => {
        const root = makeRepo();
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        mockedChanged.mockReturnValue(['skills/alpha/src/x.ts']);

        const cap = captureStd();
        try {
            const code = await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: [],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: false,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            expect(code).toBe(0);
            expect(fakeSpawn).toHaveBeenCalledTimes(1);
            const { argv } = fakeSpawn.mock.calls[0][0];
            expect(argv).toEqual(['run', 'skills/alpha/a.eval.ts']);
            // Run-start summary goes to stderr.
            const err = cap.stderr();
            expect(err).toContain('base = origin/main@abc1234');
            expect(err).toContain('selected: 1 / 2 evals');
            expect(err).toContain('skipped: 1');
            expect(err).toContain('→ vitest run skills/alpha/a.eval.ts');
        } finally {
            cap.restore();
        }
    });

    it('empty selection: prints "no affected evals" and does not spawn vitest', async () => {
        const root = makeRepo();
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        mockedChanged.mockReturnValue(['totally/unrelated/path.ts']);

        const cap = captureStd();
        try {
            const code = await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: [],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: false,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            expect(code).toBe(0);
            expect(fakeSpawn).not.toHaveBeenCalled();
            expect(cap.stderr()).toContain('no affected evals');
        } finally {
            cap.restore();
        }
    });

    it('--quiet suppresses the run-start summary but not errors', async () => {
        const root = makeRepo();
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        mockedChanged.mockReturnValue(['skills/alpha/x.ts']);

        const cap = captureStd();
        try {
            await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: [],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: true,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            expect(cap.stderr()).not.toContain('base =');
        } finally {
            cap.restore();
        }
    });

    it('git-resolution failure exits non-zero and never spawns vitest', async () => {
        const root = makeRepo();
        mockedResolve.mockReturnValue({
            error: 'pathgrade: merge-base resolution failed — ensure the `actions/checkout` step has `fetch-depth: 0`',
        });

        const cap = captureStd();
        try {
            const code = await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: [],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: false,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            expect(code).toBe(1);
            expect(fakeSpawn).not.toHaveBeenCalled();
            expect(cap.stderr()).toMatch(/fetch-depth/);
        } finally {
            cap.restore();
        }
    });

    it('forwards extra vitest args (`--grep foo`) alongside the selection', async () => {
        const root = makeRepo();
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        mockedChanged.mockReturnValue(['skills/alpha/x.ts']);

        const cap = captureStd();
        try {
            await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: ['--grep', 'foo'],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: true,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            const { argv } = fakeSpawn.mock.calls[0][0];
            expect(argv).toEqual(['run', 'skills/alpha/a.eval.ts', '--grep', 'foo']);
        } finally {
            cap.restore();
        }
    });

    it('--changed-files=<path> bypasses git', async () => {
        const root = makeRepo();
        const cf = path.join(os.tmpdir(), `cf-${Date.now()}.txt`);
        fs.writeFileSync(cf, 'skills/beta/x.ts\n');
        mockedResolve.mockImplementation(() => { throw new Error('should not run'); });

        const cap = captureStd();
        try {
            await runChanged({
                cwd: root,
                parsed: {
                    vitestArgs: [],
                    forceDiagnostics: false,
                    forceVerbose: false,
                    changed: true,
                    quiet: false,
                    changedFilesPath: cf,
                },
                spawnVitest: fakeSpawn,
            });
            cap.restore();
            const { argv } = fakeSpawn.mock.calls[0][0];
            expect(argv).toEqual(['run', 'skills/beta/b.eval.ts']);
        } finally {
            cap.restore();
            try { fs.unlinkSync(cf); } catch {}
        }
    });
});
