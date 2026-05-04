/**
 * Git-based change detection for affected-eval-selection.
 *
 * Resolves the base ref (merge-base preferred) and computes the repo-relative
 * file list that changed between that base and HEAD. See PRD §"Change Detection".
 *
 * Three precedence branches for base-ref resolution, in order:
 *   1. `GITHUB_BASE_REF` (GitHub Actions pull_request event) → merge-base
 *      between `refs/remotes/origin/$GITHUB_BASE_REF` and `HEAD`.
 *   2. `GITHUB_EVENT_BEFORE` (push event) if non-zero SHA → diff vs. that SHA.
 *      The all-zero SHA (`000…000`) is emitted on branch-first-push and falls
 *      through to branch 3.
 *   3. Fallback: `git merge-base HEAD origin/main`, then `origin/master`.
 *
 * Merge-base (not plain two-dot) is critical for long-lived branches whose
 * base has diverged. Vitest's built-in `--changed` gets this wrong; we must not.
 */

import { execFileSync } from 'child_process';

const ALL_ZERO_SHA = '0000000000000000000000000000000000000000';

export type BaseRefResolution =
    | { base: string; sha: string }
    | { error: string };

/**
 * Resolve the git base ref to diff against. Accepts an env object (defaults
 * to `process.env`) so tests can exercise each precedence branch.
 */
export function resolveBaseRef(env: NodeJS.ProcessEnv = process.env): BaseRefResolution {
    const { GITHUB_BASE_REF, GITHUB_EVENT_BEFORE } = env;

    if (GITHUB_BASE_REF) {
        const ref = `refs/remotes/origin/${GITHUB_BASE_REF}`;
        try {
            const sha = runGit(['merge-base', ref, 'HEAD']);
            return { base: ref, sha };
        } catch (err) {
            return { error: formatMergeBaseError(err) };
        }
    }

    if (GITHUB_EVENT_BEFORE && GITHUB_EVENT_BEFORE !== ALL_ZERO_SHA) {
        // Explicit SHA: no merge-base resolution needed.
        return { base: GITHUB_EVENT_BEFORE, sha: GITHUB_EVENT_BEFORE };
    }

    // Fallback: merge-base with common default branch names.
    let lastError: unknown;
    for (const base of ['origin/main', 'origin/master']) {
        try {
            const sha = runGit(['merge-base', 'HEAD', base]);
            return { base, sha };
        } catch (err) {
            lastError = err;
        }
    }
    return { error: formatMergeBaseError(lastError) };
}

/**
 * Repo-relative file list changed between `<base>...HEAD`. The three-dot
 * form covers adds, modifications, deletions, and both sides of renames.
 */
export function computeChangedFiles(base: string): string[] {
    const output = runGit(['diff', '--relative', '--name-only', `${base}...HEAD`]);
    return output
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
}

function runGit(args: string[]): string {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function formatMergeBaseError(err: unknown): string {
    const detail = err instanceof Error ? err.message : String(err);
    return (
        `pathgrade: merge-base resolution failed — ensure the \`actions/checkout\` step ` +
        `has \`fetch-depth: 0\` (shallow clones break merge-base). ` +
        `Underlying error: ${detail}`
    );
}
