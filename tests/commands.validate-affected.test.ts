import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runValidateAffected } from '../src/commands/validate.js';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-validate-aff-'));
}
function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

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

describe('runValidateAffected (pathgrade validate --affected)', () => {
    it('exits 0 when every eval has a SKILL.md ancestor', async () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/a/SKILL.md', '# a');
        writeFile(root, 'skills/a/a.eval.ts', 'export {};\n');
        writeFile(root, 'skills/b/SKILL.md', '# b');
        writeFile(root, 'skills/b/b.eval.ts', 'export {};\n');

        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout()).toContain('anchored at skills/a');
            expect(cap.stdout()).toContain('anchored at skills/b');
            expect(cap.stdout()).toMatch(/2 evals, 0 errors/);
        } finally {
            cap.restore();
        }
    });

    it('exits 0 when an eval has valid __pathgradeMeta (no SKILL.md required)', async () => {
        const root = makeTempRepo();
        writeFile(
            root,
            'evals/standalone.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { deps: ['integration/**'] };
`,
        );

        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout()).toContain('__pathgradeMeta present');
        } finally {
            cap.restore();
        }
    });

    it('exits 1 when an eval is onMissing (no anchor, no meta)', async () => {
        const root = makeTempRepo();
        writeFile(root, 'orphan.eval.ts', 'export {};\n');

        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(1);
            expect(cap.stdout()).toContain('no SKILL.md ancestor');
            expect(cap.stdout()).toMatch(/1 evals, 1 errors/);
        } finally {
            cap.restore();
        }
    });

    it('exits 1 when an eval has malformed meta', async () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/a/SKILL.md', '# a');
        writeFile(
            root,
            'skills/a/a.eval.ts',
            `export const __pathgradeMeta = { deps: 'not-array' };\n`,
        );

        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(1);
            expect(cap.stdout()).toMatch(/array of strings/);
        } finally {
            cap.restore();
        }
    });

    it('mixed pass/fail: exits 1 and reports both', async () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/a/SKILL.md', '# a');
        writeFile(root, 'skills/a/a.eval.ts', 'export {};\n');
        writeFile(root, 'orphan.eval.ts', 'export {};\n');

        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(1);
            expect(cap.stdout()).toMatch(/2 evals, 1 errors/);
        } finally {
            cap.restore();
        }
    });

    it('empty repo (no evals) → exit 0', async () => {
        const root = makeTempRepo();
        const cap = captureStd();
        try {
            const code = await runValidateAffected(root);
            cap.restore();
            expect(code).toBe(0);
            expect(cap.stdout()).toMatch(/0 evals, 0 errors/);
        } finally {
            cap.restore();
        }
    });
});
