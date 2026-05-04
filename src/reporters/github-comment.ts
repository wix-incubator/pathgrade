/**
 * Pure markdown formatting and GitHub PR comment posting for pathgrade.
 *
 * The pure formatter (`formatReportMarkdown`) has no side effects. The
 * GitHub API layer (`resolvePrContext`, `postOrUpdateComment`) talks to
 * the GitHub issues-comments API via `fetch`, with graceful fallback on
 * missing context or HTTP errors — the `pathgrade report` command is
 * display-only and must never fail CI.
 */

import * as fs from 'fs';
import type {
    PathgradeGroupReport,
    PathgradeReport,
    PathgradeSelectionReport,
    StrippedTrialResult,
} from '../types.js';

export interface FormatOptions {
    commentId: string;
}

/** Minimal body posted when `.pathgrade/results.json` is missing. */
export const MISSING_RESULTS_BODY =
    'Pathgrade evals did not produce results. Check the workflow logs.';

export function commentMarker(commentId: string): string {
    return `<!-- pathgrade:${commentId} -->`;
}

function pct(n: number): string {
    return `${(n * 100).toFixed(1)}%`;
}

function durationSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function computeAvgDuration(trials: readonly StrippedTrialResult[]): number {
    if (trials.length === 0) return 0;
    return trials.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0) / trials.length;
}

function escapeTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Format a pathgrade PR comment as markdown.
 *
 * The string starts with the dedup comment marker and is intended to be
 * posted as a GitHub issue comment body.
 */
export function formatReportMarkdown(
    report: PathgradeReport,
    opts: FormatOptions,
): string {
    const totalTrials = report.groups.reduce((n, g) => n + g.trials.length, 0);
    const p = report.overall_pass_rate;
    const overallPassAtK = totalTrials > 0 ? 1 - Math.pow(1 - p, totalTrials) : 0;
    const overallPassPowK = totalTrials > 0 ? Math.pow(p, totalTrials) : 0;
    const icon = report.status === 'pass' ? '✅' : '❌';

    const lines: string[] = [];
    lines.push(commentMarker(opts.commentId));
    lines.push('');
    lines.push(`### ${icon} Pathgrade report`);
    lines.push('');
    lines.push(
        `**Pass rate:** ${pct(p)}  |  ` +
            `**pass@${totalTrials}:** ${pct(overallPassAtK)}  |  ` +
            `**pass^${totalTrials}:** ${pct(overallPassPowK)}`,
    );

    if (report.threshold != null) {
        lines.push('');
        lines.push(`Threshold: ${pct(report.threshold)} — ${report.status.toUpperCase()}`);
    }

    lines.push('');
    lines.push('| Group | Pass rate | pass@k | pass^k | Skills | Avg duration |');
    lines.push('|---|---|---|---|---|---|');
    for (const group of report.groups) {
        const skills = group.skills_used.length > 0 ? group.skills_used.join(', ') : '—';
        const avg = computeAvgDuration(group.trials);
        lines.push(
            `| ${escapeTableCell(group.task)} | ${pct(group.pass_rate)} | ${pct(group.pass_at_k)} | ${pct(group.pass_pow_k)} | ${escapeTableCell(skills)} | ${durationSeconds(avg)} |`,
        );
    }

    if (report.selection) {
        lines.push('');
        lines.push(formatSelectionSection(report.selection));
    }

    for (const group of report.groups) {
        lines.push('');
        lines.push(formatGroupDetails(group));
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * Render the `### Selection` section for the PR comment. Pure: no fs,
 * no network, no reporter side effects. Three variants:
 *
 *   - `global_match` set → "global trigger fired" one-liner, no collapsible.
 *   - `skipped` empty + `selected` non-empty → "every eval had a matching
 *     change" one-liner.
 *   - otherwise → "Ran **X of Y**" line + `<details>` block listing
 *     skipped eval paths as inline code.
 */
export function formatSelectionSection(selection: PathgradeSelectionReport): string {
    const out: string[] = [];
    out.push('### Selection');

    const total = selection.selected.length + selection.skipped.length;

    if (selection.global_match) {
        out.push(
            `Ran **all ${total}** evals — global trigger \`${selection.global_match}\` matched.`,
        );
        return out.join('\n');
    }

    if (selection.skipped.length === 0 && selection.selected.length > 0) {
        out.push(
            `Ran **all ${total}** evals — every eval had a matching change.`,
        );
        return out.join('\n');
    }

    out.push(
        `Ran **${selection.selected.length} of ${total}** evals based on changes vs \`${selection.base_ref}\`.`,
    );
    if (selection.skipped.length > 0) {
        out.push('');
        out.push(`<details><summary>${selection.skipped.length} skipped (unaffected)</summary>`);
        out.push('');
        for (const s of selection.skipped) {
            out.push(`- \`${s.file}\``);
        }
        out.push('');
        out.push('</details>');
    }
    return out.join('\n');
}

// ----- GitHub API layer ------------------------------------------------------

export interface PrContext {
    owner: string;
    repo: string;
    prNumber: number;
    token: string;
}

export interface PrEnv {
    GITHUB_TOKEN?: string;
    GITHUB_REPOSITORY?: string;
    GITHUB_REF?: string;
    GITHUB_EVENT_PATH?: string;
}

function parsePrNumberFromRef(ref?: string): number | null {
    if (!ref) return null;
    // refs/pull/<n>/merge  or  refs/pull/<n>/head
    const m = ref.match(/^refs\/pull\/(\d+)\//);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
}

function readPrNumberFromEvent(eventPath?: string): number | null {
    if (!eventPath) return null;
    try {
        const raw = fs.readFileSync(eventPath, 'utf-8');
        const payload = JSON.parse(raw);
        const n = payload?.pull_request?.number;
        return typeof n === 'number' && Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the GitHub PR context from CI env vars. Returns `null` when any
 * required field is missing — callers should skip posting and fall back
 * to stdout.
 */
export function resolvePrContext(env: PrEnv): PrContext | null {
    const token = env.GITHUB_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    if (!token || !repo) return null;
    const [owner, repoName] = repo.split('/', 2);
    if (!owner || !repoName) return null;
    const prNumber =
        readPrNumberFromEvent(env.GITHUB_EVENT_PATH) ??
        parsePrNumberFromRef(env.GITHUB_REF);
    if (prNumber == null) return null;
    return { owner, repo: repoName, prNumber, token };
}

interface GithubComment {
    id: number;
    body: string;
}

function apiHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pathgrade-report',
    };
}

async function listPrComments(ctx: PrContext): Promise<GithubComment[]> {
    const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments?per_page=100`;
    const res = await fetch(url, { headers: apiHeaders(ctx.token) });
    if (!res.ok) {
        throw new Error(`GET ${url} returned ${res.status}`);
    }
    const data = (await res.json()) as GithubComment[];
    return Array.isArray(data) ? data : [];
}

async function createPrComment(ctx: PrContext, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`;
    const res = await fetch(url, {
        method: 'POST',
        headers: apiHeaders(ctx.token),
        body: JSON.stringify({ body }),
    });
    if (!res.ok) {
        throw new Error(`POST ${url} returned ${res.status}`);
    }
}

async function updatePrComment(ctx: PrContext, commentId: number, body: string): Promise<void> {
    const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/comments/${commentId}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: apiHeaders(ctx.token),
        body: JSON.stringify({ body }),
    });
    if (!res.ok) {
        throw new Error(`PATCH ${url} returned ${res.status}`);
    }
}

export interface PostOptions {
    commentId: string;
    /** Body WITHOUT the marker — the marker is prepended if not already present. */
    body: string;
}

/** GitHub's documented hard limit for issue-comment bodies. */
const GITHUB_COMMENT_MAX = 65536;
const TRUNCATION_SENTINEL =
    '\n\n_…output truncated to fit GitHub\'s comment size limit — see the workflow artifacts for the full report._';

/**
 * Find an existing PR comment carrying `<!-- pathgrade:${commentId} -->`
 * and update it; otherwise create a new one. Swallows all errors (logs
 * to stderr) — `pathgrade report` must never fail CI.
 *
 * Bodies longer than GitHub's 65,536-character limit are truncated with a
 * sentinel pointing to workflow artifacts, preserving the leading dedup
 * marker so subsequent runs still find and update this comment.
 */
export async function postOrUpdateComment(ctx: PrContext, opts: PostOptions): Promise<void> {
    const marker = commentMarker(opts.commentId);
    const withMarker = opts.body.startsWith(marker) ? opts.body : `${marker}\n${opts.body}`;
    const body =
        withMarker.length <= GITHUB_COMMENT_MAX
            ? withMarker
            : withMarker.slice(0, GITHUB_COMMENT_MAX - TRUNCATION_SENTINEL.length) +
              TRUNCATION_SENTINEL;

    try {
        const existing = await listPrComments(ctx);
        const match = existing.find((c) => typeof c.body === 'string' && c.body.includes(marker));
        if (match) {
            await updatePrComment(ctx, match.id, body);
        } else {
            await createPrComment(ctx, body);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`pathgrade report: failed to post PR comment — ${message}`);
    }
}

function formatGroupDetails(group: PathgradeGroupReport): string {
    const out: string[] = [];
    out.push('<details>');
    out.push(`<summary>${escapeTableCell(group.task)} — per-trial breakdown</summary>`);
    out.push('');
    for (const trial of group.trials) {
        out.push(`#### ${trial.name ?? `trial ${trial.trial_id}`}`);
        const reason = trial.diagnostics?.completionReason ?? '—';
        out.push(
            `reward: **${trial.reward.toFixed(2)}**  |  duration: ${durationSeconds(trial.duration_ms)}  |  completion: \`${reason}\``,
        );
        if (trial.scorer_results.length > 0) {
            out.push('');
            out.push('| Scorer | Score | Weight | Details |');
            out.push('|---|---|---|---|');
            for (const s of trial.scorer_results) {
                out.push(
                    `| ${escapeTableCell(s.scorer_type)} | ${s.score.toFixed(2)} | ${s.weight.toFixed(2)} | ${escapeTableCell(s.details ?? '')} |`,
                );
            }
        }
        const warnings = trial.diagnostics?.warnings ?? [];
        if (warnings.length > 0) {
            out.push('');
            out.push('Warnings:');
            for (const w of warnings) {
                out.push(`- ${w}`);
            }
        }
        out.push('');
    }
    out.push('</details>');
    return out.join('\n');
}
