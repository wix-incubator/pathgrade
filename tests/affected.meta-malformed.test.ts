import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parsePathgradeMeta } from '../src/affected/meta.js';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/affected/meta');

describe('parsePathgradeMeta — malformed meta is a hard error', () => {
    it('non-array deps throws with file path and reason', () => {
        const fp = path.join(FIXTURE_ROOT, 'malformed-deps.eval.ts');
        expect(() => parsePathgradeMeta(fp)).toThrow(/array of strings/);
        expect(() => parsePathgradeMeta(fp)).toThrow(new RegExp(path.basename(fp)));
    });

    it('invalid glob syntax (unbalanced bracket) throws', () => {
        const fp = path.join(FIXTURE_ROOT, 'malformed-glob.eval.ts');
        expect(() => parsePathgradeMeta(fp)).toThrow(/glob/i);
    });

    it('path escape (../../) throws', () => {
        const fp = path.join(FIXTURE_ROOT, 'path-escape.eval.ts');
        expect(() => parsePathgradeMeta(fp)).toThrow(/outside.*repo|path.*escape|\.\./i);
    });
});
