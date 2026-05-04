/**
 * Repo-root-relative glob matching helpers for the affected-selection pipeline.
 *
 * All paths — both globs and test paths — must be repo-root-relative with
 * forward slashes. Callers are responsible for normalization.
 */

import picomatch from 'picomatch';

function toMatcher(glob: string): (p: string) => boolean {
    return picomatch(glob, { dot: true });
}

export interface GlobIntersection {
    /** If any file matched any glob, which glob fired (first match wins). */
    matchedGlob?: string;
    matched: boolean;
}

/**
 * Return `{ matched: true, matchedGlob }` if any path in `files` matches any
 * glob in `globs`. Iteration order: globs outer, files inner — we surface the
 * first glob (in declared order) that has at least one hit.
 */
export function intersect(globs: string[], files: string[]): GlobIntersection {
    for (const glob of globs) {
        const match = toMatcher(glob);
        for (const f of files) {
            if (match(f)) return { matched: true, matchedGlob: glob };
        }
    }
    return { matched: false };
}
