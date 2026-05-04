import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { selectAffected } from '../src/affected/select.js';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-global-'));
}
function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function setupMonorepo(): string {
    const root = makeTempRepo();
    writeFile(root, 'skills/a/SKILL.md', '# a');
    writeFile(root, 'skills/a/a.eval.ts', 'export {};\n');
    writeFile(root, 'skills/b/SKILL.md', '# b');
    writeFile(root, 'skills/b/b.eval.ts', 'export {};\n');
    writeFile(root, 'skills/c/SKILL.md', '# c');
    writeFile(root, 'skills/c/c.eval.ts', 'export {};\n');
    writeFile(root, 'skills/d/SKILL.md', '# d');
    writeFile(root, 'skills/d/d.eval.ts', 'export {};\n');
    return root;
}

describe('selectAffected — affected.global short-circuit', () => {
    it('no global config → behaves like Issue 5 (no globalMatch field)', () => {
        const root = setupMonorepo();
        const result = selectAffected({
            evalFiles: ['skills/a/a.eval.ts'],
            changedFiles: ['skills/a/foo.ts'],
            repoRoot: root,
            baseRef: 'explicit',
        });
        expect(result.globalMatch).toBeUndefined();
    });

    it('global glob matches → every eval selected with reason global-match', () => {
        const root = setupMonorepo();
        const result = selectAffected({
            evalFiles: [
                'skills/a/a.eval.ts',
                'skills/b/b.eval.ts',
                'skills/c/c.eval.ts',
                'skills/d/d.eval.ts',
            ],
            changedFiles: ['vitest.config.ts'],
            repoRoot: root,
            baseRef: 'explicit',
            global: ['vitest.config.ts', 'package.json'],
        });
        expect(result.globalMatch).toBe('vitest.config.ts');
        expect(result.selected).toHaveLength(4);
        expect(result.selected.every(s => s.reason === 'global-match')).toBe(true);
        expect(result.skipped).toEqual([]);
    });

    it('global glob does not match → behaves like no global config', () => {
        const root = setupMonorepo();
        const result = selectAffected({
            evalFiles: ['skills/a/a.eval.ts', 'skills/b/b.eval.ts'],
            changedFiles: ['skills/a/foo.ts'],
            repoRoot: root,
            baseRef: 'explicit',
            global: ['package.json'],
        });
        expect(result.globalMatch).toBeUndefined();
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].reason).toBe('deps-match');
    });

    it('first matching glob wins when multiple globals match', () => {
        const root = setupMonorepo();
        const result = selectAffected({
            evalFiles: ['skills/a/a.eval.ts'],
            changedFiles: ['package-lock.json', 'package.json'],
            repoRoot: root,
            baseRef: 'explicit',
            global: ['package.json', 'package-lock.json'],
        });
        expect(result.globalMatch).toBe('package.json');
    });
});
