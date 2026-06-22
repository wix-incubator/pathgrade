import { describe, expect, it } from 'vitest';
import { buildPathgradeReport } from '../src/reporting/core.js';
import type { ReportRunInput } from '../src/reporting/types.js';

describe('runner-neutral reporting contract', () => {
    it('builds compatible report artifacts from pure normalized inputs', () => {
        const input: ReportRunInput = {
            threshold: 0.8,
            groups: [
                {
                    groupName: 'math.eval.ts > calculator',
                    cases: [
                        {
                            name: 'uses the last evaluation',
                            state: 'passed',
                            runnerDurationMs: 1_500,
                            evaluations: [
                                {
                                    score: 0.1,
                                    trial: {
                                        trial_id: 99,
                                        reward: 0.1,
                                        scorer_results: [],
                                        duration_ms: 300,
                                        n_commands: 1,
                                        input_tokens: 2,
                                        output_tokens: 3,
                                        session_log: [],
                                    },
                                },
                                {
                                    score: 0.75,
                                    diagnostics: {
                                        turns: 1,
                                        totalDurationMs: 1_200,
                                        completionReason: 'completed',
                                        score: 0.75,
                                        recommendedTimeoutMs: 2_000,
                                        turnDetails: [],
                                        reactionsFired: [],
                                        runtimePoliciesApplied: [],
                                        scorers: [],
                                        warnings: [],
                                    },
                                    trial: {
                                        trial_id: 100,
                                        reward: 0.7,
                                        scorer_results: [{ scorer_type: 'judge', score: 0.75, weight: 1, details: 'ok' }],
                                        duration_ms: 0,
                                        n_commands: 4,
                                        input_tokens: 10,
                                        output_tokens: 20,
                                        conversation_input_tokens: 5,
                                        conversation_output_tokens: 6,
                                        conversation_cost_usd: 0.01,
                                        total_cost_usd: 0.02,
                                        session_log: [
                                            {
                                                type: 'tool_event',
                                                timestamp: '2026-01-01T00:00:00.000Z',
                                                tool_event: {
                                                    action: 'use_skill',
                                                    provider: 'claude',
                                                    providerToolName: 'Skill',
                                                    summary: 'used tdd',
                                                    confidence: 'high',
                                                    rawSnippet: '...',
                                                    skillName: 'tdd',
                                                },
                                            },
                                        ],
                                        conversation: {
                                            total_turns: 1,
                                            completion_reason: 'done_phrase',
                                            turns: [],
                                        },
                                    },
                                },
                            ],
                        },
                        {
                            name: 'plain vitest pass fallback',
                            state: 'passed',
                            runnerDurationMs: 500,
                        },
                        {
                            name: 'empty metadata fallback',
                            state: 'failed',
                            runnerDurationMs: 250,
                            evaluations: [],
                        },
                        {
                            name: 'skipped is excluded',
                            state: 'skipped',
                            runnerDurationMs: 100,
                            evaluations: [{ score: 1 }],
                        },
                        {
                            name: 'pending is excluded',
                            state: 'pending',
                            runnerDurationMs: 100,
                            evaluations: [{ score: 1 }],
                        },
                    ],
                },
            ],
        };

        const built = buildPathgradeReport(input);

        expect(built.warnings).toEqual([
            'empty results for "empty metadata fallback" — evaluate() may not have been called',
        ]);
        expect(built.report).toMatchObject({
            version: 1,
            threshold: 0.8,
            overall_pass_rate: (0.75 + 1 + 0) / 3,
            status: 'fail',
            groups: [
                {
                    task: 'math.eval.ts > calculator',
                    pass_rate: 2 / 3,
                    pass_at_k: 1 - Math.pow(1 - 2 / 3, 3),
                    pass_pow_k: Math.pow(2 / 3, 3),
                    skills_used: ['tdd'],
                    trace_file: 'traces/math-eval-ts-calculator.json',
                },
            ],
        });
        expect(built.report.timestamp).toEqual(expect.any(String));
        expect(built.report.groups[0].trials).toHaveLength(3);
        expect(built.report.groups[0].trials[0]).toMatchObject({
            trial_id: 1,
            name: 'uses the last evaluation',
            reward: 0.7,
            duration_ms: 1_500,
            diagnostics: { completionReason: 'completed' },
            scorer_results: [{ scorer_type: 'judge' }],
            n_commands: 4,
            input_tokens: 10,
            output_tokens: 20,
            conversation_input_tokens: 5,
            conversation_output_tokens: 6,
            conversation_cost_usd: 0.01,
            total_cost_usd: 0.02,
            skills_used: ['tdd'],
        });
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('session_log');
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('conversation');
        expect(built.traces).toEqual([
            {
                traceFile: 'traces/math-eval-ts-calculator.json',
                trials: expect.arrayContaining([
                    expect.objectContaining({
                        name: 'uses the last evaluation',
                        reward: 0.7,
                        session_log: expect.arrayContaining([expect.objectContaining({ type: 'tool_event' })]),
                        conversation: expect.objectContaining({ completion_reason: 'done_phrase' }),
                    }),
                ]),
            },
        ]);
    });

    it('passes selection metadata through and uses runner state for non-threshold status', () => {
        const built = buildPathgradeReport({
            selection: {
                base_ref: 'origin/main@abc123',
                changed_files_count: 1,
                selected: ['failing.eval.ts'],
                skipped: [],
            },
            groups: [
                {
                    groupName: 'failing.eval.ts',
                    cases: [
                        {
                            name: 'runner failed even with a passing score',
                            state: 'failed',
                            runnerDurationMs: 10,
                            evaluations: [{ score: 1 }],
                        },
                    ],
                },
            ],
        });

        expect(built.report.overall_pass_rate).toBe(1);
        expect(built.report.status).toBe('fail');
        expect(built.report.selection).toEqual({
            base_ref: 'origin/main@abc123',
            changed_files_count: 1,
            selected: ['failing.eval.ts'],
            skipped: [],
        });
    });

    it('keeps empty-metadata warnings for skipped cases while excluding them from artifacts', () => {
        const built = buildPathgradeReport({
            groups: [
                {
                    groupName: 'skip.eval.ts',
                    cases: [
                        {
                            name: 'skipped pathgrade setup',
                            state: 'skipped',
                            runnerDurationMs: 1,
                            evaluations: [],
                        },
                    ],
                },
            ],
        });

        expect(built.warnings).toEqual([
            'empty results for "skipped pathgrade setup" — evaluate() may not have been called',
        ]);
        expect(built.report.groups).toEqual([]);
        expect(built.traces).toEqual([]);
    });
});
