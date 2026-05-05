import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectAffected } from '../src/affected/select.js';

function makeTempRepo(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-alwaysrun-'));
    return tmp;
}

function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('selectAffected — alwaysRun', () => {
    it('alwaysRun: true unions the eval into selection regardless of dep match', () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/smoke/SKILL.md', '# smoke');
        writeFile(
            root,
            'skills/smoke/test/smoke.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { alwaysRun: true };
`,
        );

        const result = selectAffected({
            evalFiles: ['skills/smoke/test/smoke.eval.ts'],
            changedFiles: ['completely/unrelated/path.ts'],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].reason).toBe('always-run');
        expect(result.skipped).toHaveLength(0);
    });

    it('empty changed-file set still yields alwaysRun eval in selection', () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/smoke/SKILL.md', '# smoke');
        writeFile(
            root,
            'skills/smoke/test/smoke.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { alwaysRun: true };
`,
        );
        const result = selectAffected({
            evalFiles: ['skills/smoke/test/smoke.eval.ts'],
            changedFiles: [],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].reason).toBe('always-run');
    });

    it('alwaysRun: true + deps precedence — alwaysRun wins even when deps would have matched', () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/smoke/SKILL.md', '# smoke');
        writeFile(
            root,
            'skills/smoke/test/smoke.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { alwaysRun: true, deps: ['custom/**'] };
`,
        );
        const result = selectAffected({
            evalFiles: ['skills/smoke/test/smoke.eval.ts'],
            changedFiles: ['custom/foo.ts'],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].reason).toBe('always-run');
    });
});

describe('selectAffected — onMissing fail-closed', () => {
    it('eval with no SKILL.md and no meta emits a warning and selects with reason', () => {
        const root = makeTempRepo();
        writeFile(root, 'orphan.eval.ts', 'export {};\n');

        const result = selectAffected({
            evalFiles: ['orphan.eval.ts'],
            changedFiles: ['unrelated.ts'],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.selected).toEqual([
            { file: 'orphan.eval.ts', reason: 'on-missing-fail-closed' },
        ]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('orphan.eval.ts');
        expect(result.warnings[0]).toMatch(/SKILL\.md|__pathgradeMeta|fail-closed/);
    });

    it('no warning when eval has a SKILL.md anchor even if nothing changed', () => {
        const root = makeTempRepo();
        writeFile(root, 'skills/ok/SKILL.md', '# ok');
        writeFile(root, 'skills/ok/ok.eval.ts', 'export {};\n');

        const result = selectAffected({
            evalFiles: ['skills/ok/ok.eval.ts'],
            changedFiles: ['unrelated.ts'],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.warnings).toEqual([]);
        expect(result.selected).toEqual([]);
        expect(result.skipped).toHaveLength(1);
    });
});
