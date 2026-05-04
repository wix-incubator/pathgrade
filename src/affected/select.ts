/**
 * Core selection pipeline for affected-eval-selection.
 *
 * Given a set of discovered eval files and a set of changed files,
 * computes which evals should run. See `docs/003-affected-eval-selection.md`
 * §"Design Overview" and §"Precedence" for the authoritative specification.
 *
 * Precedence (when multiple mechanisms apply):
 *   1. `affected.global` match short-circuits and selects every discovered
 *      eval. (Wiring lands in Issue 8.)
 *   2. `alwaysRun: true` unconditionally unions the eval into selection.
 *   3. `deps` (full override) replaces the auto-detected skill root.
 *   4. `extraDeps` is unioned with `deps` or the skill root.
 *   5. Auto-detected skill root (`<skillRoot>/**`) is the default.
 *   6. `onMissing` (no anchor + no meta) → fail-closed select with warning.
 */

import * as path from 'path';
import { findSkillRoot } from './anchor.js';
import { parsePathgradeMeta, type ParsedMeta } from './meta.js';
import { intersect } from './glob.js';
import type { SelectionResult, SelectionEntry, SelectionSkipped } from './types.js';

export interface SelectAffectedInput {
    evalFiles: string[];
    changedFiles: string[];
    repoRoot: string;
    baseRef: string;
    /**
     * Repo-level "rerun everything" triggers from `pathgrade()` plugin
     * options (`affected.global`). Any match short-circuits selection and
     * every discovered eval is selected with reason `global-match`.
     */
    global?: string[];
}

export function selectAffected(input: SelectAffectedInput): SelectionResult {
    const { evalFiles, changedFiles, repoRoot, baseRef, global } = input;

    const selected: SelectionEntry[] = [];
    const skipped: SelectionSkipped[] = [];
    const warnings: string[] = [];

    // Precedence #1: global match short-circuits everything.
    if (global && global.length > 0) {
        const hit = intersect(global, changedFiles);
        if (hit.matched) {
            for (const evalFile of evalFiles) {
                selected.push({ file: evalFile, reason: 'global-match' });
            }
            selected.sort((a, b) => a.file.localeCompare(b.file));
            return {
                baseRef,
                changedFiles: [...changedFiles],
                globalMatch: hit.matchedGlob,
                selected,
                skipped,
                warnings,
            };
        }
    }

    for (const evalFile of evalFiles) {
        const absEval = path.resolve(repoRoot, evalFile);
        const skillRoot = findSkillRoot(absEval, repoRoot);
        const meta = parsePathgradeMeta(absEval);

        // Precedence #2: alwaysRun wins over dep matching.
        if (meta?.alwaysRun === true) {
            selected.push({ file: evalFile, reason: 'always-run' });
            continue;
        }

        // Precedence #6: fail-closed when we have no signal at all.
        if (!skillRoot && !meta) {
            selected.push({ file: evalFile, reason: 'on-missing-fail-closed' });
            warnings.push(
                `${evalFile}: no SKILL.md anchor and no __pathgradeMeta — selecting fail-closed`,
            );
            continue;
        }

        const depGlobs = resolveDepGlobs(skillRoot, meta);
        if (depGlobs.length === 0) {
            // Meta present but declares no deps (e.g., `{}`). Treat as
            // fail-closed — the user left deps ambiguous.
            selected.push({ file: evalFile, reason: 'on-missing-fail-closed' });
            warnings.push(
                `${evalFile}: __pathgradeMeta declares no deps and no SKILL.md anchor — selecting fail-closed`,
            );
            continue;
        }

        const hit = intersect(depGlobs, changedFiles);
        if (hit.matched) {
            selected.push({
                file: evalFile,
                reason: 'deps-match',
                matchedGlob: hit.matchedGlob,
            });
        } else {
            skipped.push({ file: evalFile, reason: 'no-matching-deps' });
        }
    }

    selected.sort((a, b) => a.file.localeCompare(b.file));
    skipped.sort((a, b) => a.file.localeCompare(b.file));

    return {
        baseRef,
        changedFiles: [...changedFiles],
        selected,
        skipped,
        warnings,
    };
}

function resolveDepGlobs(skillRoot: string | null, meta: ParsedMeta | null): string[] {
    const globs: string[] = [];
    if (meta?.deps && meta.deps.length > 0) {
        globs.push(...meta.deps);
    } else if (skillRoot) {
        globs.push(`${skillRoot}/**`);
    }
    if (meta?.extraDeps && meta.extraDeps.length > 0) {
        globs.push(...meta.extraDeps);
    }
    return globs;
}
