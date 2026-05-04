import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { findSkillRoot } from '../src/affected/anchor.js';

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/affected');

describe('findSkillRoot', () => {
    it('finds SKILL.md in the same directory as the eval (flat layout)', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'skill-flat');
        const evalFile = path.join(repoRoot, 'skills/foo/foo.eval.ts');
        expect(findSkillRoot(evalFile, repoRoot)).toBe('skills/foo');
    });

    it('walks up to find SKILL.md for nested evals', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'skill-nested');
        const evalFile = path.join(repoRoot, 'skills/foo/test/foo.eval.ts');
        expect(findSkillRoot(evalFile, repoRoot)).toBe('skills/foo');
    });

    it('picks the nearest SKILL.md when multiple exist in the ancestor chain', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'multi-skill');
        const evalFile = path.join(repoRoot, 'skills/outer/inner/inner.eval.ts');
        expect(findSkillRoot(evalFile, repoRoot)).toBe('skills/outer/inner');
    });

    it('returns null when no SKILL.md ancestor exists', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'no-anchor');
        const evalFile = path.join(repoRoot, 'orphan.eval.ts');
        expect(findSkillRoot(evalFile, repoRoot)).toBeNull();
    });

    it('accepts repo-relative eval paths', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'skill-flat');
        expect(findSkillRoot('skills/foo/foo.eval.ts', repoRoot)).toBe('skills/foo');
    });

    it('returns posix-style paths regardless of platform', () => {
        const repoRoot = path.join(FIXTURE_ROOT, 'skill-nested');
        const evalFile = path.join(repoRoot, 'skills/foo/test/foo.eval.ts');
        const result = findSkillRoot(evalFile, repoRoot);
        expect(result).not.toContain('\\');
    });
});
