/**
 * Skill-anchor resolution for affected-eval selection.
 *
 * Walks the directory tree upward from an eval file looking for the nearest
 * `SKILL.md` file. The first ancestor directory containing `SKILL.md` is the
 * **skill root**. Returns the skill root path repo-relative (forward slashes),
 * or `null` if no ancestor has `SKILL.md`.
 */

import * as fs from 'fs';
import * as path from 'path';

function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

/**
 * Resolve the nearest SKILL.md ancestor directory for an eval file.
 *
 * @param evalFile  Absolute or repo-relative path to the `.eval.ts` file.
 * @param repoRoot  Absolute path to the repo root. All returned paths are
 *                  repo-root-relative with forward slashes.
 * @returns the skill root directory path (e.g., `"skills/foo"`), or `null`
 *          if no `SKILL.md` ancestor is found up to the repo root.
 */
export function findSkillRoot(evalFile: string, repoRoot: string): string | null {
    const absEvalFile = path.isAbsolute(evalFile)
        ? evalFile
        : path.resolve(repoRoot, evalFile);
    const absRepoRoot = path.resolve(repoRoot);

    let current = path.dirname(absEvalFile);
    while (true) {
        if (fs.existsSync(path.join(current, 'SKILL.md'))) {
            const rel = path.relative(absRepoRoot, current);
            return rel === '' ? '.' : toPosix(rel);
        }
        if (current === absRepoRoot) break;
        const parent = path.dirname(current);
        if (parent === current) break; // filesystem root
        current = parent;
    }
    return null;
}
