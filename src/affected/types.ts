/**
 * Shared types for the affected-eval-selection pipeline.
 *
 * This file is the single source of truth for the `SelectionResult` shape
 * and `SelectionReason` enum. Extended across Issues 5–11; do not duplicate.
 */

export type SelectionReason =
    | 'deps-match'
    | 'always-run'
    | 'global-match'
    | 'on-missing-fail-closed';

export interface SelectionEntry {
    file: string;
    reason: SelectionReason;
    /** Glob that matched a changed file (populated for `deps-match` / `global-match`). */
    matchedGlob?: string;
}

export interface SelectionSkipped {
    file: string;
    reason: 'no-matching-deps';
}

export interface SelectionResult {
    /** `"<ref>@<sha>"`, or `"explicit"` for `--changed-files` inputs. */
    baseRef: string;
    changedFiles: string[];
    /** Glob from `affected.global` that fired short-circuit, if any. */
    globalMatch?: string;
    selected: SelectionEntry[];
    skipped: SelectionSkipped[];
    warnings: string[];
}

/**
 * Public SDK type — exported from `pathgrade` so evals can annotate
 * their `__pathgradeMeta` export with a typed shape.
 *
 * `onMissing` is intentionally NOT a user-writable field: it names
 * pathgrade's *runtime behavior* when an eval has neither a SKILL.md
 * anchor nor an explicit meta declaration.
 */
export interface PathgradeMeta {
    /** Full-override dep globs (repo-relative). Replaces auto-detected SKILL.md anchor. */
    deps?: string[];
    /** Additional dep globs unioned with the auto-detected SKILL.md anchor. */
    extraDeps?: string[];
    /** When true, unconditionally include this eval in every `pathgrade run --changed`. */
    alwaysRun?: boolean;
}
