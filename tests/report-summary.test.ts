import { afterEach, describe, expect, it, vi } from 'vitest';
import { printReportSummary } from '../src/reporters/report-summary.js';
import type { ReportSummaryGroup } from '../src/reporting/types.js';

describe('report summary presentation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints compatible summary metrics and diagnostics from built report summaries', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const summaries: ReportSummaryGroup[] = [
            {
                task: 'diagnostics.eval.ts > flow',
                pass_rate: 0.5,
                pass_at_k: 0.75,
                pass_pow_k: 0.25,
                average_duration_ms: 1_500,
                trial_count: 2,
                diagnostics: [
                    {
                        caseName: 'passing eval',
                        state: 'passed',
                        report: {
                            turns: 1,
                            totalDurationMs: 1_000,
                            completionReason: 'completed',
                            score: 1,
                            recommendedTimeoutMs: 2_000,
                            turnDetails: [],
                            reactionsFired: [],
                            runtimePoliciesApplied: [],
                            scorers: [],
                            warnings: [],
                        },
                    },
                    {
                        caseName: 'crashed eval',
                        state: 'passed',
                        report: {
                            turns: 1,
                            totalDurationMs: 3_000,
                            completionReason: 'agent_crashed',
                            completionDetail: 'process exited',
                            score: 0,
                            recommendedTimeoutMs: 4_000,
                            turnDetails: [],
                            reactionsFired: [],
                            runtimePoliciesApplied: [],
                            scorers: [],
                            warnings: [],
                        },
                    },
                ],
            },
        ];

        printReportSummary(summaries, { currentTimeoutMs: 5_000 });

        const output = log.mock.calls.map(call => String(call[0])).join('\n');
        expect(output).toContain('diagnostics.eval.ts > flow');
        expect(output).toContain('50.0%');
        expect(output).toContain('pass@2');
        expect(output).toContain('75.0%');
        expect(output).toContain('avg time');
        expect(output).toContain('1.5s');
        expect(output).toContain('passing eval');
        expect(output).toContain('1 turn  1.0s  completed  score 1.00');
        expect(output).toContain('crashed eval');
        expect(output).toContain('Unified Diagnostics');
        expect(output).toContain('Agent crashed: process exited');
    });
});
