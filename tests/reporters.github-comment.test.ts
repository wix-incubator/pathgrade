import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';
import type { PathgradeReport } from '../src/types.js';
import {
    commentMarker,
    formatReportMarkdown,
    MISSING_RESULTS_BODY,
    postOrUpdateComment,
    resolvePrContext,
} from '../src/reporters/github-comment.js';

function makeReport(overrides?: Partial<PathgradeReport>): PathgradeReport {
    return {
        version: 1,
        timestamp: '2026-04-13T10:00:00.000Z',
        overall_pass_rate: 0.75,
        status: 'pass',
        groups: [
            {
                task: 'fix-bug.eval.ts > fix the bug',
                pass_rate: 0.5,
                pass_at_k: 0.75,
                pass_pow_k: 0.25,
                skills_used: ['debugging', 'tdd'],
                trace_file: 'traces/fix-the-bug.json',
                trials: [
                    {
                        trial_id: 1,
                        name: 'trial 1',
                        reward: 1,
                        scorer_results: [
                            { scorer_type: 'artifact', score: 1, weight: 1, details: 'all files created' },
                            { scorer_type: 'quality', score: 0.8, weight: 1, details: 'LGTM' },
                        ],
                        duration_ms: 12000,
                        n_commands: 4,
                        input_tokens: 1200,
                        output_tokens: 400,
                        diagnostics: {
                            completionReason: 'done_phrase',
                            warnings: ['skipped a step'],
                        } as any,
                    },
                    {
                        trial_id: 2,
                        name: 'trial 2',
                        reward: 0,
                        scorer_results: [
                            { scorer_type: 'artifact', score: 0, weight: 1, details: 'missing file' },
                        ],
                        duration_ms: 8000,
                        n_commands: 2,
                        input_tokens: 600,
                        output_tokens: 200,
                        diagnostics: {
                            completionReason: 'timeout',
                            warnings: [],
                        } as any,
                    },
                ],
            },
        ],
        ...overrides,
    };
}

describe('formatReportMarkdown', () => {
    it('starts with the comment marker for the given comment-id', () => {
        const md = formatReportMarkdown(makeReport(), { commentId: 'ci:evals' });
        expect(md.startsWith('<!-- pathgrade:ci:evals -->')).toBe(true);
    });

    it('renders a pass icon when status is pass', () => {
        const md = formatReportMarkdown(makeReport({ status: 'pass' }), { commentId: 'default' });
        expect(md).toContain('✅');
        expect(md).not.toContain('❌');
    });

    it('renders a fail icon when status is fail', () => {
        const md = formatReportMarkdown(makeReport({ status: 'fail', overall_pass_rate: 0.1 }), { commentId: 'default' });
        expect(md).toContain('❌');
    });

    it('includes overall pass rate, pass@k, pass^k as percentages', () => {
        const md = formatReportMarkdown(makeReport(), { commentId: 'default' });
        // overall_pass_rate = 0.75 = 75.0%
        expect(md).toMatch(/75\.0%/);
        // total k = 2 trials (one group, two trials)
        // pass@2 = 1 - 0.25^2 = 0.9375 = 93.8%
        expect(md).toMatch(/93\.8%/);
        // pass^2 = 0.75^2 = 0.5625 = 56.3%
        expect(md).toMatch(/56\.3%/);
        // labels
        expect(md).toMatch(/pass@\d+/);
        expect(md).toMatch(/pass\^\d+/);
    });

    it('renders a summary table row per group with pass rate, pass@k, pass^k, skills, avg duration', () => {
        const md = formatReportMarkdown(makeReport(), { commentId: 'default' });
        // Summary table header
        expect(md).toContain('| Group |');
        // Per-group row
        expect(md).toContain('fix-bug.eval.ts > fix the bug');
        // group pass rate 0.5 = 50.0%
        expect(md).toMatch(/50\.0%/);
        // skills listed
        expect(md).toContain('debugging');
        expect(md).toContain('tdd');
        // avg duration (12s + 8s) / 2 = 10s
        expect(md).toMatch(/10\.0s/);
    });

    it('renders a collapsible details block per group with per-trial rows', () => {
        const md = formatReportMarkdown(makeReport(), { commentId: 'default' });
        expect(md).toContain('<details>');
        expect(md).toContain('</details>');
        // per-trial reward, duration, completion reason
        expect(md).toContain('trial 1');
        expect(md).toContain('trial 2');
        expect(md).toContain('done_phrase');
        expect(md).toContain('timeout');
        // scorer breakdown
        expect(md).toContain('artifact');
        expect(md).toContain('quality');
        // diagnostics warnings
        expect(md).toContain('skipped a step');
    });

    it('handles an empty groups array without throwing', () => {
        const md = formatReportMarkdown(makeReport({ groups: [], overall_pass_rate: 0 }), { commentId: 'default' });
        expect(md).toContain('<!-- pathgrade:default -->');
        expect(md).toMatch(/0\.0%/);
    });

    it('gracefully renders trials with no diagnostics', () => {
        const report = makeReport();
        report.groups[0].trials[0].diagnostics = undefined;
        const md = formatReportMarkdown(report, { commentId: 'default' });
        expect(md).toContain('trial 1');
    });

    // ---- Issue 12: selection section ----
    describe('selection section (Issue 12)', () => {
        it('is absent when report.selection is undefined (byte-compat)', () => {
            const md = formatReportMarkdown(makeReport(), { commentId: 'default' });
            expect(md).not.toContain('### Selection');
        });

        it('renders "Ran X of Y" with a collapsible skipped list (normal case)', () => {
            const md = formatReportMarkdown(makeReport({
                selection: {
                    base_ref: 'origin/main@abc1234',
                    changed_files_count: 3,
                    selected: [
                        'skills/ck-handoff/test/ck-handoff.eval.ts',
                        'skills/ck-flow-product/test/ck-flow-product.eval.ts',
                    ],
                    skipped: [
                        { file: 'skills/ck-new/test/ck-new.eval.ts', reason: 'no-matching-deps' },
                        { file: 'skills/ck-product-spec/test/ck-product-spec.eval.ts', reason: 'no-matching-deps' },
                    ],
                },
            }), { commentId: 'default' });
            expect(md).toContain('### Selection');
            expect(md).toContain('Ran **2 of 4** evals');
            expect(md).toContain('origin/main@abc1234');
            expect(md).toContain('<summary>2 skipped (unaffected)</summary>');
            expect(md).toContain('`skills/ck-new/test/ck-new.eval.ts`');
            expect(md).toContain('`skills/ck-product-spec/test/ck-product-spec.eval.ts`');
        });

        it('renders the global-trigger variant when global_match is set', () => {
            const md = formatReportMarkdown(makeReport({
                selection: {
                    base_ref: 'origin/main@abc1234',
                    changed_files_count: 1,
                    global_match: 'package-lock.json',
                    selected: ['a.eval.ts', 'b.eval.ts'],
                    skipped: [],
                },
            }), { commentId: 'default' });
            expect(md).toContain('### Selection');
            expect(md).toContain('global trigger');
            expect(md).toContain('`package-lock.json`');
            expect(md).not.toContain('skipped (unaffected)');
        });

        it('renders the "every eval" variant when skipped is empty and selected is non-empty', () => {
            const md = formatReportMarkdown(makeReport({
                selection: {
                    base_ref: 'origin/main@abc1234',
                    changed_files_count: 1,
                    selected: ['a.eval.ts', 'b.eval.ts'],
                    skipped: [],
                },
            }), { commentId: 'default' });
            expect(md).toContain('every eval had a matching change');
            expect(md).not.toContain('skipped (unaffected)');
            expect(md).not.toContain('global trigger');
        });

        it('handles a single-skipped-entry case', () => {
            const md = formatReportMarkdown(makeReport({
                selection: {
                    base_ref: 'origin/main@abc1234',
                    changed_files_count: 1,
                    selected: ['a.eval.ts'],
                    skipped: [{ file: 'b.eval.ts', reason: 'no-matching-deps' }],
                },
            }), { commentId: 'default' });
            expect(md).toContain('<summary>1 skipped (unaffected)</summary>');
            expect(md).toContain('`b.eval.ts`');
        });
    });
});

describe('MISSING_RESULTS_BODY', () => {
    it('is the documented minimal error message', () => {
        expect(MISSING_RESULTS_BODY).toContain('Pathgrade evals did not produce results');
    });

    it('includes a comment marker placeholder consumer', () => {
        // MISSING_RESULTS_BODY is pure text; the marker is prepended at the call site.
        expect(typeof MISSING_RESULTS_BODY).toBe('string');
    });
});

describe('commentMarker', () => {
    it('produces a stable <!-- pathgrade:${id} --> marker', () => {
        expect(commentMarker('ci:evals')).toBe('<!-- pathgrade:ci:evals -->');
    });
});

describe('resolvePrContext', () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = path.join(os.tmpdir(), `pathgrade-ctx-${Date.now()}-${Math.random()}`);
        await fsExtra.ensureDir(tempDir);
    });

    afterEach(async () => {
        try { await fsExtra.remove(tempDir); } catch {}
    });

    it('returns null when GITHUB_TOKEN is missing', () => {
        const ctx = resolvePrContext({
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_REF: 'refs/pull/42/merge',
        });
        expect(ctx).toBeNull();
    });

    it('returns null when GITHUB_REPOSITORY is missing', () => {
        const ctx = resolvePrContext({
            GITHUB_TOKEN: 'tok',
            GITHUB_REF: 'refs/pull/42/merge',
        });
        expect(ctx).toBeNull();
    });

    it('returns null when no PR number can be resolved', () => {
        const ctx = resolvePrContext({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_REF: 'refs/heads/main',
        });
        expect(ctx).toBeNull();
    });

    it('resolves PR number from GITHUB_EVENT_PATH event payload when present', async () => {
        const eventPath = path.join(tempDir, 'event.json');
        await fsExtra.writeJson(eventPath, { pull_request: { number: 123 } });
        const ctx = resolvePrContext({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_EVENT_PATH: eventPath,
        });
        expect(ctx).toEqual({ owner: 'owner', repo: 'repo', prNumber: 123, token: 'tok' });
    });

    it('falls back to parsing GITHUB_REF when event payload is missing the PR number', () => {
        const ctx = resolvePrContext({
            GITHUB_TOKEN: 'tok',
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_REF: 'refs/pull/99/merge',
        });
        expect(ctx).toEqual({ owner: 'owner', repo: 'repo', prNumber: 99, token: 'tok' });
    });
});

describe('postOrUpdateComment', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let originalFetch: typeof globalThis.fetch | undefined;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        originalFetch = globalThis.fetch;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = fetchMock;
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = originalFetch;
        errSpy.mockRestore();
    });

    const ctx = { owner: 'acme', repo: 'evals', prNumber: 17, token: 'tok' };

    it('creates a new comment when no existing comment carries the marker', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (typeof url === 'string' && url.includes('/comments') && (!init || !init.method || init.method === 'GET')) {
                // List existing comments — none match
                return new Response(JSON.stringify([
                    { id: 1, body: 'random feedback' },
                    { id: 2, body: '<!-- pathgrade:other -->\nsome other bucket' },
                ]), { status: 200 });
            }
            // Create
            return new Response(JSON.stringify({ id: 99 }), { status: 201 });
        });

        await postOrUpdateComment(ctx, { commentId: 'ci:evals', body: 'hello' });

        const calls = fetchMock.mock.calls;
        const postCall = calls.find(([, init]) => init?.method === 'POST');
        expect(postCall).toBeDefined();
        expect(postCall![0]).toContain(`/repos/acme/evals/issues/17/comments`);
        const parsed = JSON.parse(postCall![1].body as string);
        expect(parsed.body.startsWith('<!-- pathgrade:ci:evals -->')).toBe(true);
        expect(parsed.body).toContain('hello');
    });

    it('updates an existing comment carrying the matching marker', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (typeof url === 'string' && url.includes('/issues/17/comments') && (!init || init.method === 'GET' || !init.method)) {
                return new Response(JSON.stringify([
                    { id: 42, body: '<!-- pathgrade:ci:evals -->\nold body' },
                    { id: 43, body: '<!-- pathgrade:other -->\nold other' },
                ]), { status: 200 });
            }
            return new Response(JSON.stringify({ id: 42 }), { status: 200 });
        });

        await postOrUpdateComment(ctx, { commentId: 'ci:evals', body: 'new body' });

        const calls = fetchMock.mock.calls;
        const patchCall = calls.find(([, init]) => init?.method === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(patchCall![0]).toContain('/repos/acme/evals/issues/comments/42');
        expect(JSON.parse(patchCall![1].body as string).body).toContain('new body');
        // Should not POST a new comment
        expect(calls.find(([, init]) => init?.method === 'POST')).toBeUndefined();
    });

    it('different comment-ids produce separate comments on the same PR', async () => {
        const existing = [
            { id: 50, body: '<!-- pathgrade:suite-a -->\nA body' },
        ];
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (!init || init.method === 'GET' || !init.method) {
                return new Response(JSON.stringify(existing), { status: 200 });
            }
            return new Response(JSON.stringify({ id: 99 }), { status: 201 });
        });

        await postOrUpdateComment(ctx, { commentId: 'suite-b', body: 'B body' });
        const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(posted).toBeDefined();
        // Did not PATCH the suite-a comment
        expect(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')).toBeUndefined();
    });

    it('never throws when the API returns an error', async () => {
        fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
        await expect(
            postOrUpdateComment(ctx, { commentId: 'x', body: 'body' }),
        ).resolves.toBeUndefined();
        // Should log to stderr
        expect(errSpy).toHaveBeenCalled();
    });

    it('never throws when fetch itself rejects', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));
        await expect(
            postOrUpdateComment(ctx, { commentId: 'x', body: 'body' }),
        ).resolves.toBeUndefined();
        expect(errSpy).toHaveBeenCalled();
    });

    it('sends Authorization: Bearer ${token}', async () => {
        fetchMock.mockImplementation(async () => new Response('[]', { status: 200 }));
        await postOrUpdateComment(ctx, { commentId: 'x', body: 'body' });
        const call = fetchMock.mock.calls[0];
        expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
    });

    it('truncates body exceeding GitHub comment size limit and appends a sentinel', async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (!init || init.method === 'GET' || !init.method) {
                return new Response('[]', { status: 200 });
            }
            return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        });

        // 100 KB of content — well over GitHub's 65536 char limit.
        const huge = 'x'.repeat(100_000);
        await postOrUpdateComment(ctx, { commentId: 'ci:evals', body: huge });

        const posted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
        expect(posted).toBeDefined();
        const sentBody = JSON.parse(posted![1].body as string).body as string;
        // Must fit within GitHub's 65,536-char comment limit.
        expect(sentBody.length).toBeLessThanOrEqual(65536);
        // Marker must still be present for dedup on subsequent runs.
        expect(sentBody.startsWith('<!-- pathgrade:ci:evals -->')).toBe(true);
        // Sentinel must tell the reader content was truncated.
        expect(sentBody.toLowerCase()).toContain('truncated');
    });
});
