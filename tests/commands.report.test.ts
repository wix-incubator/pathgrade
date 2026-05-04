import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('fs-extra', () => {
    const mock = {
        pathExists: vi.fn(),
        readJSON: vi.fn(),
    };
    return { default: mock, ...mock };
});

vi.mock('../src/reporters/github-comment.js', async (orig) => {
    const actual = await orig<typeof import('../src/reporters/github-comment.js')>();
    return {
        ...actual,
        postOrUpdateComment: vi.fn().mockResolvedValue(undefined),
    };
});

import fs from 'fs-extra';
import { runReport } from '../src/commands/report.js';
import { postOrUpdateComment } from '../src/reporters/github-comment.js';
import type { PathgradeReport } from '../src/types.js';

const mockedPost = vi.mocked(postOrUpdateComment);

const mockedFs = vi.mocked(fs);

function makeReport(overrides?: Partial<PathgradeReport>): PathgradeReport {
    return {
        version: 1,
        timestamp: '2026-04-13T10:00:00.000Z',
        overall_pass_rate: 0.75,
        status: 'pass',
        groups: [
            {
                task: 'fix-bug.eval.ts > fix the bug',
                pass_rate: 0.75,
                pass_at_k: 0.94,
                pass_pow_k: 0.56,
                skills_used: ['tdd'],
                trace_file: 'traces/fix-the-bug.json',
                trials: [
                    {
                        trial_id: 1,
                        name: 'trial 1',
                        reward: 1,
                        scorer_results: [],
                        duration_ms: 1000,
                        n_commands: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                    },
                ],
            },
        ],
        ...overrides,
    };
}

let stdoutLines: string[];
let stderrLines: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let originalExitCode: typeof process.exitCode;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    vi.resetAllMocks();
    stdoutLines = [];
    stderrLines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => {
        stdoutLines.push(String(s ?? ''));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation((s?: unknown) => {
        stderrLines.push(String(s ?? ''));
    });
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    originalEnv = { ...process.env };
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_JOB;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REF;
    delete process.env.GITHUB_EVENT_PATH;
});

afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = originalExitCode;
    process.env = originalEnv;
});

describe('runReport — stdout contract', () => {
    it('reads .pathgrade/results.json by default', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        expect(mockedFs.readJSON).toHaveBeenCalledWith(
            path.join('/project', '.pathgrade', 'results.json'),
        );
    });

    it('honors --results-path override', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', { resultsPath: 'out/custom.json' });

        expect(mockedFs.readJSON).toHaveBeenCalledWith(
            path.join('/project', 'out', 'custom.json'),
        );
    });

    it('final line of stdout is the pass rate as a plain number', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport({ overall_pass_rate: 0.85 }) as never);

        await runReport('/project', {});

        const all = stdoutLines.join('\n').split('\n').filter(Boolean);
        expect(all[all.length - 1]).toBe('0.85');
    });

    it('prints markdown first, then a blank line, then the pass rate (Issue 3 default)', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        const full = stdoutLines.join('\n');
        // markdown contains the comment marker
        expect(full).toContain('<!-- pathgrade:');
        // Ends with pass rate on its own line
        expect(full.trimEnd().split('\n').pop()).toBe('0.75');
        // There is a blank line between markdown and pass rate
        expect(full).toMatch(/\n\n0\.75\n?$/);
    });

    it('--no-comment also prints markdown + pass rate (same as Issue 3 default)', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', { noComment: true });

        const full = stdoutLines.join('\n');
        expect(full).toContain('<!-- pathgrade:');
        expect(full.trimEnd().split('\n').pop()).toBe('0.75');
    });

    it('Issue 3 prints markdown + pass rate even in CI (since posting is not wired)', async () => {
        process.env.GITHUB_ACTIONS = 'true';
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        const full = stdoutLines.join('\n');
        expect(full).toContain('<!-- pathgrade:');
        expect(full.trimEnd().split('\n').pop()).toBe('0.75');
    });
});

describe('runReport — comment-id defaulting', () => {
    it('falls back to ${GITHUB_WORKFLOW}:${GITHUB_JOB} when both are set', async () => {
        process.env.GITHUB_WORKFLOW = 'CI';
        process.env.GITHUB_JOB = 'evals';
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        expect(stdoutLines.join('\n')).toContain('<!-- pathgrade:CI:evals -->');
    });

    it('falls back to ${GITHUB_WORKFLOW} when only that is set', async () => {
        process.env.GITHUB_WORKFLOW = 'CI';
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        expect(stdoutLines.join('\n')).toContain('<!-- pathgrade:CI -->');
    });

    it('falls back to "default" literal when no env is set', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        expect(stdoutLines.join('\n')).toContain('<!-- pathgrade:default -->');
    });

    it('honors --comment-id over env fallback', async () => {
        process.env.GITHUB_WORKFLOW = 'CI';
        process.env.GITHUB_JOB = 'evals';
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', { commentId: 'my-bucket' });

        expect(stdoutLines.join('\n')).toContain('<!-- pathgrade:my-bucket -->');
    });
});

describe('runReport — posting path (Issue 4)', () => {
    beforeEach(() => {
        process.env.GITHUB_ACTIONS = 'true';
        process.env.GITHUB_TOKEN = 'tok';
        process.env.GITHUB_REPOSITORY = 'acme/evals';
        process.env.GITHUB_REF = 'refs/pull/7/merge';
    });

    it('posts markdown when in CI with full PR context and prints only the pass rate', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport({ overall_pass_rate: 0.9 }) as never);

        await runReport('/project', {});

        expect(mockedPost).toHaveBeenCalledTimes(1);
        const [ctx, opts] = mockedPost.mock.calls[0];
        expect(ctx).toEqual({ owner: 'acme', repo: 'evals', prNumber: 7, token: 'tok' });
        expect(opts.body).toContain('<!-- pathgrade:default -->');

        // Stdout: only the pass rate (no markdown)
        const full = stdoutLines.join('\n');
        expect(full.trim()).toBe('0.9');
        expect(full).not.toContain('<!-- pathgrade:');
    });

    it('--no-comment in CI still prints markdown to stdout and does not post', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', { noComment: true });

        expect(mockedPost).not.toHaveBeenCalled();
        expect(stdoutLines.join('\n')).toContain('<!-- pathgrade:');
    });

    it('when PR context is incomplete (no token), falls back to printing markdown to stdout', async () => {
        delete process.env.GITHUB_TOKEN;
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport() as never);

        await runReport('/project', {});

        expect(mockedPost).not.toHaveBeenCalled();
        const full = stdoutLines.join('\n');
        expect(full).toContain('<!-- pathgrade:');
        expect(full.trimEnd().split('\n').pop()).toBe('0.75');
    });

    it('when results are missing in CI with PR context, posts the minimal error comment', async () => {
        mockedFs.pathExists.mockResolvedValue(false as never);

        await runReport('/project', {});

        expect(mockedPost).toHaveBeenCalledTimes(1);
        const [, opts] = mockedPost.mock.calls[0];
        expect(opts.body).toContain('Pathgrade evals did not produce results');
        // Stdout still has a pass rate line (0)
        expect(stdoutLines.join('\n').trim().split('\n').pop()).toBe('0');
    });
});

describe('runReport — error handling', () => {
    it('prints an error to stderr and exits 0 when results.json is missing', async () => {
        mockedFs.pathExists.mockResolvedValue(false as never);

        await runReport('/project', {});

        expect(stderrLines.join('\n')).toMatch(/pathgrade report/);
        expect(process.exitCode).not.toBe(1);
    });

    it('prints an error to stderr and exits 0 when results.json is malformed', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue({ not: 'a report' } as never);

        await runReport('/project', {});

        expect(stderrLines.join('\n')).toMatch(/pathgrade report/);
        expect(process.exitCode).not.toBe(1);
    });

    it('never sets a failing exit code, even when status is fail', async () => {
        mockedFs.pathExists.mockResolvedValue(true as never);
        mockedFs.readJSON.mockResolvedValue(makeReport({ status: 'fail', overall_pass_rate: 0.1 }) as never);

        await runReport('/project', {});

        expect(process.exitCode).not.toBe(1);
    });
});
