import { describe, it, expect } from 'vitest';
import { formatExplain, formatJson } from '../src/affected/format.js';
import type { SelectionResult } from '../src/affected/types.js';

function makeResult(overrides: Partial<SelectionResult> = {}): SelectionResult {
    return {
        baseRef: 'origin/main@abc1234',
        changedFiles: ['skills/alpha/src/foo.ts'],
        selected: [
            { file: 'skills/alpha/test/alpha.eval.ts', reason: 'deps-match', matchedGlob: 'skills/alpha/**' },
        ],
        skipped: [
            { file: 'skills/beta/test/beta.eval.ts', reason: 'no-matching-deps' },
        ],
        warnings: [],
        ...overrides,
    };
}

describe('formatJson — snake_case wire shape', () => {
    it('serializes with snake_case keys (camelCase → snake_case)', () => {
        const result = makeResult();
        const json = JSON.parse(formatJson(result));
        expect(json).toEqual({
            base_ref: 'origin/main@abc1234',
            changed_files: ['skills/alpha/src/foo.ts'],
            selected: [
                {
                    file: 'skills/alpha/test/alpha.eval.ts',
                    reason: 'deps-match',
                    matched_glob: 'skills/alpha/**',
                },
            ],
            skipped: [
                { file: 'skills/beta/test/beta.eval.ts', reason: 'no-matching-deps' },
            ],
            warnings: [],
        });
        // No `globalMatch` field when unset (undefined is stripped).
        expect('global_match' in json).toBe(false);
    });

    it('includes global_match when populated', () => {
        const result = makeResult({
            globalMatch: 'vitest.config.ts',
            selected: [
                { file: 'skills/alpha/test/alpha.eval.ts', reason: 'global-match' },
                { file: 'skills/beta/test/beta.eval.ts', reason: 'global-match' },
            ],
            skipped: [],
        });
        const json = JSON.parse(formatJson(result));
        expect(json.global_match).toBe('vitest.config.ts');
        expect(json.selected.every((s: any) => s.reason === 'global-match')).toBe(true);
    });

    it('output is stable across runs (sorted lists)', () => {
        const r = makeResult();
        expect(formatJson(r)).toBe(formatJson(r));
    });
});

describe('formatExplain — human-readable stderr output', () => {
    it('shows base ref, changed file count, per-eval decision with reason', () => {
        const out = formatExplain(makeResult());
        expect(out).toContain('origin/main@abc1234');
        expect(out).toContain('changed files: 1');
        expect(out).toContain('skills/alpha/test/alpha.eval.ts');
        expect(out).toContain('deps match');
        expect(out).toContain('skills/alpha/**');
        expect(out).toContain('skills/beta/test/beta.eval.ts');
        expect(out).toContain('skipped');
    });

    it('renders onMissing warnings when present', () => {
        const out = formatExplain(makeResult({
            warnings: ['skills/orphan/o.eval.ts: no SKILL.md anchor'],
        }));
        expect(out).toMatch(/warning/i);
        expect(out).toContain('orphan');
    });

    it('renders global-match as a short-circuit one-liner', () => {
        const out = formatExplain(makeResult({
            globalMatch: 'vitest.config.ts',
            selected: [{ file: 'x.eval.ts', reason: 'global-match' }],
            skipped: [],
        }));
        expect(out).toContain('vitest.config.ts');
        expect(out).toContain('global');
    });
});
