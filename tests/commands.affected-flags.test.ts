import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

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

describe('pathgrade affected --explain / --json', () => {
    beforeEach(() => {
        mockedResolve.mockReset();
        mockedChanged.mockReset();
        mockedResolve.mockReturnValue({ base: 'origin/main', sha: 'abc1234' });
        mockedChanged.mockReturnValue(['skills/alpha/src/x.ts']);
    });

    it('--explain writes a human-readable summary to stderr; stdout list unchanged', async () => {
        const cap = captureStd();
        try {
            const code = await runAffected({ cwd: MONOREPO, explain: true });
            cap.restore();
            expect(code).toBe(0);
            // Stdout is still the plain file list (Issue 5 behavior).
            expect(cap.stdout()).toContain('skills/alpha/test/alpha.eval.ts');
            // Explain goes to stderr.
            expect(cap.stderr()).toContain('base:');
            expect(cap.stderr()).toContain('deps match');
        } finally {
            cap.restore();
        }
    });

    it('--json writes structured output to stdout; no plain-list mode', async () => {
        const cap = captureStd();
        try {
            const code = await runAffected({ cwd: MONOREPO, json: true });
            cap.restore();
            expect(code).toBe(0);
            const parsed = JSON.parse(cap.stdout());
            expect(parsed.base_ref).toBe('origin/main@abc1234');
            expect(parsed.selected).toEqual(expect.arrayContaining([
                expect.objectContaining({ reason: 'deps-match' }),
            ]));
        } finally {
            cap.restore();
        }
    });

    it('--json + --explain: json on stdout, explain on stderr', async () => {
        const cap = captureStd();
        try {
            await runAffected({ cwd: MONOREPO, json: true, explain: true });
            cap.restore();
            expect(() => JSON.parse(cap.stdout())).not.toThrow();
            expect(cap.stderr()).toContain('base:');
        } finally {
            cap.restore();
        }
    });
});
