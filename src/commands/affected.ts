/**
 * `pathgrade affected` — the selection primitive.
 *
 * Input precedence for the change-set (Issue 6):
 *   1. `--changed-files=<path>` wins unconditionally (non-git contexts).
 *   2. `--since=<ref>` diffs `<ref>...HEAD`.
 *   3. No flags → auto-derive base ref from GitHub Actions env + git merge-base.
 *
 * Output contract: one selected path per stdout line, sorted lexicographically.
 * The resolved base-ref one-liner goes to stderr so it doesn't pollute the
 * composable stdout list. Issues 7/8/10 wire warnings, global short-circuit,
 * and `--explain` / `--json` presentation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { selectAffected } from '../affected/select.js';
import { resolveBaseRef, computeChangedFiles } from '../affected/git.js';
import { formatExplain, formatJson } from '../affected/format.js';
import type { SelectionResult } from '../affected/types.js';
import { discoverPathgradeEvalFiles } from '../evals/discovery.js';
import {
    DEFAULT_EVAL_EXCLUDE,
    DEFAULT_EVAL_INCLUDE,
    resolvePathgradeConfig,
} from '../config/pathgrade.js';

export interface RunAffectedOptions {
    /** Absolute path to the repo root (CLI passes `process.cwd()`). */
    cwd: string;
    standalone?: boolean;
    /** Newline-delimited list of repo-relative changed files (overrides git). */
    changedFilesPath?: string;
    /** Git ref to diff against (`<ref>...HEAD`). Overrides auto-detection. */
    since?: string;
    /** Emit a human-readable summary to stderr. Stdout contract unchanged. */
    explain?: boolean;
    /** Emit structured JSON to stdout instead of the plain list. */
    json?: boolean;
}

interface ResolvedChanges {
    baseRef: string;
    changedFiles: string[];
    /** One-line summary to print to stderr before the selection. */
    baseRefLine?: string;
}

export async function runAffected(opts: RunAffectedOptions): Promise<number> {
    const { cwd } = opts;

    let changes: ResolvedChanges;
    try {
        const resolved = resolveChangeSet(opts);
        if ('error' in resolved) {
            process.stderr.write(`${resolved.error}\n`);
            return 1;
        }
        changes = resolved;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pathgrade affected: ${msg}\n`);
        return 1;
    }

    if (changes.baseRefLine) {
        process.stderr.write(`${changes.baseRefLine}\n`);
    }

    let config: Awaited<ReturnType<typeof resolvePathgradeConfig>>;
    try {
        config = await resolvePathgradeConfig({
            cwd,
            standalone: opts.standalone,
            warn: w => process.stderr.write(`${w}\n`),
        });
    } catch (err) {
        process.stderr.write(`pathgrade affected: ${errMsg(err)}\n`);
        return 1;
    }
    const evalFiles = discoverPathgradeEvalFiles({
        cwd,
        include: config.evals.include,
        exclude: config.evals.exclude,
    });

    let result: SelectionResult;
    try {
        result = selectAffected({
            evalFiles,
            changedFiles: changes.changedFiles,
            repoRoot: cwd,
            baseRef: changes.baseRef,
            global: config.affected.global,
        });
    } catch (err) {
        // Malformed `__pathgradeMeta` — the PRD requires a hard error.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pathgrade affected: ${msg}\n`);
        return 1;
    }

    // Default mode still prints warnings + global summary to stderr so the
    // Issue 5/6 behavior is preserved when neither flag is set.
    if (!opts.explain) {
        for (const w of result.warnings) {
            process.stderr.write(`warning: ${w}\n`);
        }
        if (result.globalMatch) {
            process.stderr.write(
                `pathgrade: global match: \`${result.globalMatch}\` — selecting all ${result.selected.length} evals\n`,
            );
        }
    }

    if (opts.explain) {
        process.stderr.write(formatExplain(result));
    }

    if (opts.json) {
        process.stdout.write(formatJson(result));
    } else {
        printSelectedToStdout(result);
    }
    return 0;
}

/**
 * Decide where the change-set comes from and produce it.
 *
 * Returns `{ error }` when git auto-detection fails (so the caller can
 * surface a clean stderr message); throws only on actual I/O / programmer
 * errors (e.g., unreadable `--changed-files` path).
 */
function resolveChangeSet(opts: RunAffectedOptions): ResolvedChanges | { error: string } {
    const { changedFilesPath, since } = opts;

    if (changedFilesPath) {
        let changedFiles: string[];
        try {
            changedFiles = readChangedFilesList(changedFilesPath);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`could not read --changed-files: ${msg}`);
        }
        return { baseRef: 'explicit', changedFiles };
    }

    if (since) {
        const changedFiles = computeChangedFiles(since);
        return {
            baseRef: `${since}`,
            changedFiles,
            baseRefLine: `pathgrade: base = ${since} (--since)`,
        };
    }

    // Auto-derive from git.
    const resolution = resolveBaseRef();
    if ('error' in resolution) return { error: resolution.error };
    const shortSha = resolution.sha.slice(0, 7);
    const changedFiles = computeChangedFiles(resolution.sha);
    return {
        baseRef: `${resolution.base}@${shortSha}`,
        changedFiles,
        baseRefLine: `pathgrade: base = ${resolution.base}@${shortSha} (merge-base with HEAD)`,
    };
}

function readChangedFilesList(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Discover repo-relative `*.eval.ts` files under `cwd`, honoring the same
 * exclude defaults the vitest plugin uses.
 */
export function discoverEvalFiles(cwd: string): string[] {
    return discoverPathgradeEvalFiles({
        cwd,
        include: DEFAULT_EVAL_INCLUDE,
        exclude: DEFAULT_EVAL_EXCLUDE,
    });
}

function printSelectedToStdout(result: SelectionResult): void {
    for (const entry of result.selected) {
        process.stdout.write(`${entry.file}\n`);
    }
}
