import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { selectAffected } from '../src/affected/select.js';

const MONOREPO = path.resolve(__dirname, 'fixtures/affected/monorepo');

describe('selectAffected — basic deps-match', () => {
    it('selects an eval when its skill root contains a changed file', () => {
        const result = selectAffected({
            evalFiles: ['skills/alpha/test/alpha.eval.ts'],
            changedFiles: ['skills/alpha/src/foo.ts'],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected).toEqual([
            {
                file: 'skills/alpha/test/alpha.eval.ts',
                reason: 'deps-match',
                matchedGlob: 'skills/alpha/**',
            },
        ]);
        expect(result.skipped).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.globalMatch).toBeUndefined();
        expect(result.baseRef).toBe('explicit');
        expect(result.changedFiles).toEqual(['skills/alpha/src/foo.ts']);
    });

    it('skips an eval when no changed file matches its deps', () => {
        const result = selectAffected({
            evalFiles: ['skills/alpha/test/alpha.eval.ts'],
            changedFiles: ['skills/beta/src/foo.ts'],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected).toEqual([]);
        expect(result.skipped).toEqual([
            { file: 'skills/alpha/test/alpha.eval.ts', reason: 'no-matching-deps' },
        ]);
    });

    it('respects extraDeps from __pathgradeMeta (unioned with skill root)', () => {
        // beta.eval.ts has extraDeps: ['skills/alpha/**']
        const result = selectAffected({
            evalFiles: ['skills/beta/test/beta.eval.ts'],
            changedFiles: ['skills/alpha/src/x.ts'],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].file).toBe('skills/beta/test/beta.eval.ts');
        expect(result.selected[0].reason).toBe('deps-match');
        expect(result.selected[0].matchedGlob).toBe('skills/alpha/**');
    });

    it('still matches beta via its own skill root', () => {
        const result = selectAffected({
            evalFiles: ['skills/beta/test/beta.eval.ts'],
            changedFiles: ['skills/beta/src/x.ts'],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].matchedGlob).toBe('skills/beta/**');
    });

    it('sorts selected and skipped lists lexicographically', () => {
        const result = selectAffected({
            evalFiles: [
                'skills/beta/test/beta.eval.ts',
                'skills/alpha/test/alpha.eval.ts',
            ],
            changedFiles: ['skills/alpha/src/x.ts', 'skills/beta/src/y.ts'],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected.map(s => s.file)).toEqual([
            'skills/alpha/test/alpha.eval.ts',
            'skills/beta/test/beta.eval.ts',
        ]);
    });

    it('empty changedFiles → all evals skipped (no deps match)', () => {
        const result = selectAffected({
            evalFiles: ['skills/alpha/test/alpha.eval.ts'],
            changedFiles: [],
            repoRoot: MONOREPO,
            baseRef: 'explicit',
        });
        expect(result.selected).toEqual([]);
        expect(result.skipped).toHaveLength(1);
    });
});

describe('selectAffected — deps override with __pathgradeMeta.deps', () => {
    it('deps replaces the auto-detected skill root', () => {
        const repoRoot = path.resolve(__dirname, 'fixtures/affected/select-deps-override');
        // Built inline below via the fixture we'll create.
        // If this fixture does not exist, the test acts as a trip-wire.
        // See tests/fixtures/affected/select-deps-override/*.
        const result = selectAffected({
            evalFiles: ['evals/custom.eval.ts'],
            changedFiles: ['integration/foo.ts'],
            repoRoot,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].matchedGlob).toBe('integration/**');
    });

    it('deps override: changes under the implicit skill root do NOT match when overridden', () => {
        const repoRoot = path.resolve(__dirname, 'fixtures/affected/select-deps-override');
        const result = selectAffected({
            evalFiles: ['evals/custom.eval.ts'],
            changedFiles: ['evals/unrelated.ts'],
            repoRoot,
            baseRef: 'explicit',
        });
        expect(result.selected).toEqual([]);
    });
});

describe('selectAffected — onMissing placeholder (Issue 5 tracer behavior)', () => {
    it('eval with no SKILL.md ancestor and no meta is selected with on-missing-fail-closed', () => {
        const repoRoot = path.resolve(__dirname, 'fixtures/affected/no-anchor');
        const result = selectAffected({
            evalFiles: ['orphan.eval.ts'],
            changedFiles: ['unrelated.ts'],
            repoRoot,
            baseRef: 'explicit',
        });
        expect(result.selected).toHaveLength(1);
        expect(result.selected[0].reason).toBe('on-missing-fail-closed');
    });
});
