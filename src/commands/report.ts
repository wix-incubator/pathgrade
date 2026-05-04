/**
 * `pathgrade report` command.
 *
 * Reads the consolidated `.pathgrade/results.json` and formats a markdown
 * report via `src/reporters/github-comment.ts`. Two observable behaviors:
 *
 *   - Posting path: in GitHub Actions (`GITHUB_ACTIONS === 'true'`) with a
 *     resolvable PR context and a `GITHUB_TOKEN`, posts/updates a PR
 *     comment and prints only the pass rate to stdout.
 *   - Local/fallback path: prints the markdown, a blank line, then the
 *     pass rate. Used for local runs, `--no-comment`, or any CI run
 *     missing token/PR context.
 *
 * The final line of stdout is always the pass rate as a plain number so
 * downstream workflow steps can capture it with `$(...)` or `>> $GITHUB_OUTPUT`.
 *
 * Display-only: the command never sets a failing exit code. Threshold
 * enforcement stays in `PathgradeReporter` via `ci.threshold`.
 */

import * as path from 'path';
import fs from 'fs-extra';
import type { PathgradeReport } from '../types.js';
import {
    formatReportMarkdown,
    MISSING_RESULTS_BODY,
    postOrUpdateComment,
    resolvePrContext,
} from '../reporters/github-comment.js';

export interface ReportOptions {
    /** Path to the consolidated results JSON, resolved against `cwd`. Defaults to `.pathgrade/results.json`. */
    resultsPath?: string;
    /** Skip PR comment posting; print markdown to stdout instead. */
    noComment?: boolean;
    /** Override the comment-id used in the dedup marker. See `resolveCommentId`. */
    commentId?: string;
}

const DEFAULT_RESULTS_PATH = path.join('.pathgrade', 'results.json');

/**
 * Resolve the comment-id used for the dedup marker.
 *
 * Precedence: explicit `commentId` → `$GITHUB_WORKFLOW:$GITHUB_JOB` →
 * `$GITHUB_WORKFLOW` → hard-coded literal `"default"`.
 */
export function resolveCommentId(explicit?: string): string {
    if (explicit && explicit.length > 0) return explicit;
    const workflow = process.env.GITHUB_WORKFLOW;
    const job = process.env.GITHUB_JOB;
    if (workflow && job) return `${workflow}:${job}`;
    if (workflow) return workflow;
    return 'default';
}

function isPathgradeReport(value: unknown): value is PathgradeReport {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<PathgradeReport>;
    return (
        v.version === 1 &&
        typeof v.overall_pass_rate === 'number' &&
        (v.status === 'pass' || v.status === 'fail') &&
        Array.isArray(v.groups)
    );
}

async function loadReport(resolvedPath: string): Promise<PathgradeReport> {
    if (!(await fs.pathExists(resolvedPath))) {
        throw new Error(`results file not found at ${resolvedPath}`);
    }
    const raw = await fs.readJSON(resolvedPath);
    if (!isPathgradeReport(raw)) {
        throw new Error(`results file at ${resolvedPath} is not a valid pathgrade report`);
    }
    return raw;
}

function printMarkdownAndPassRate(markdown: string, passRate: number): void {
    // Strip trailing newlines so we control spacing precisely:
    // <markdown>\n\n<pass rate>\n
    console.log(markdown.replace(/\n+$/, ''));
    console.log('');
    console.log(String(passRate));
}

/**
 * Entry point for `pathgrade report`. Never throws and never sets a
 * failing exit code — even on malformed inputs or network errors.
 */
export async function runReport(cwd: string, opts: ReportOptions = {}): Promise<void> {
    const resolvedPath = path.resolve(cwd, opts.resultsPath ?? DEFAULT_RESULTS_PATH);
    const commentId = resolveCommentId(opts.commentId);
    const inCI = process.env.GITHUB_ACTIONS === 'true';
    const noComment = opts.noComment ?? false;
    // Branch point: when true, post the comment and print only the pass rate.
    const shouldPost = inCI && !noComment;
    const prContext = shouldPost ? resolvePrContext(process.env) : null;

    let report: PathgradeReport | null = null;
    let loadError: string | null = null;
    try {
        report = await loadReport(resolvedPath);
    } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
    }

    if (loadError) {
        console.error(`pathgrade report: ${loadError}`);
        if (prContext) {
            await postOrUpdateComment(prContext, {
                commentId,
                body: MISSING_RESULTS_BODY,
            });
        }
        // Always emit a pass rate line so downstream capture doesn't explode.
        console.log('0');
        return;
    }

    const markdown = formatReportMarkdown(report!, { commentId });

    if (prContext) {
        await postOrUpdateComment(prContext, { commentId, body: markdown });
        // Only the pass rate goes to stdout — the markdown lives on the PR.
        console.log(String(report!.overall_pass_rate));
        return;
    }

    // Local / no-comment / missing CI context — print markdown + blank + pass rate.
    printMarkdownAndPassRate(markdown, report!.overall_pass_rate);
}
