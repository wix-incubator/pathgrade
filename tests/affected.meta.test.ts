import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parsePathgradeMeta } from '../src/affected/meta.js';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/affected/meta');

describe('parsePathgradeMeta', () => {
    it('parses deps-only meta from an AST without executing the module', () => {
        // The fixture has `throw new Error('do not execute')` at module top.
        // If the parser executes the module this test throws — which is the
        // whole point of the assertion.
        const meta = parsePathgradeMeta(path.join(FIXTURE_ROOT, 'with-deps.eval.ts'));
        expect(meta).toEqual({ deps: ['integration/**', 'shared/utils/**'] });
    });

    it('parses extraDeps-only meta', () => {
        const meta = parsePathgradeMeta(path.join(FIXTURE_ROOT, 'with-extra-deps.eval.ts'));
        expect(meta).toEqual({ extraDeps: ['skills/bar/**'] });
    });

    it('parses alwaysRun: true', () => {
        const meta = parsePathgradeMeta(path.join(FIXTURE_ROOT, 'always-run.eval.ts'));
        expect(meta).toEqual({ alwaysRun: true });
    });

    it('parses all three fields together', () => {
        const meta = parsePathgradeMeta(path.join(FIXTURE_ROOT, 'all-fields.eval.ts'));
        expect(meta).toEqual({
            deps: ['custom/**'],
            extraDeps: ['also/**'],
            alwaysRun: false,
        });
    });

    it('returns null when __pathgradeMeta export is absent', () => {
        const meta = parsePathgradeMeta(path.join(FIXTURE_ROOT, 'no-meta.eval.ts'));
        expect(meta).toBeNull();
    });
});
