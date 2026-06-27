import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPathgradeReport } from '../src/reporting/core.js';
import type { ReportGroupInput } from '../src/reporting/types.js';

describe('adapter boundary regressions', () => {
    it('keeps report metrics, trace paths, artifact shape, and threshold status out of adapters', () => {
        const vitestAdapterSource = fs.readFileSync(path.join(process.cwd(), 'src/runners/vitest-adapter.ts'), 'utf8');
        const vitestLifecycleSource = fs.readFileSync(path.join(process.cwd(), 'src/runners/vitest-lifecycle.ts'), 'utf8');

        for (const [name, source] of Object.entries({
            'vitest-adapter.ts': vitestAdapterSource,
            'vitest-lifecycle.ts': vitestLifecycleSource,
        })) {
            expect(source, `${name} must not compute report metrics`).not.toMatch(/\bpass_rate\b|\bpass_at_k\b|\bpass_pow_k\b|\btrace_file\b|\boverall_pass_rate\b/);
            expect(source, `${name} must not write Pathgrade artifacts`).not.toMatch(/writePathgradeArtifacts|results\.json|['"]\.pathgrade['"]/);
        }
    });

    it('accepts adapter-normalized boolean, numeric, assertion-style, and text diagnostic scores while reporting core owns math', () => {
        const groups: ReportGroupInput[] = [{
            groupName: 'future adapters',
            cases: [
                {
                    caseId: 'boolean-score',
                    name: 'boolean score',
                    state: 'passed',
                    runnerDurationMs: 1,
                    sourceRef: 'langfuse://score/boolean',
                    evaluations: [{ score: 1 }],
                },
                {
                    caseId: 'numeric-score',
                    name: 'numeric score',
                    state: 'passed',
                    runnerDurationMs: 1,
                    sourceRef: 'langfuse://score/numeric',
                    evaluations: [{ score: 0.5 }],
                },
                {
                    caseId: 'assertion-score',
                    name: 'assertion score',
                    state: 'failed',
                    runnerDurationMs: 1,
                    sourceRef: 'evalforge://assertions/1',
                    evaluations: [{
                        score: 0.25,
                        diagnostics: {
                            turns: 0,
                            totalDurationMs: 0,
                            completionReason: 'assertion-failed',
                            completionDetail: '3 of 4 assertions failed',
                            score: 0.25,
                            turnDetails: [],
                            reactionsFired: [],
                            runtimePoliciesApplied: [],
                            recommendedTimeoutMs: 30_000,
                            warnings: ['assertion failure'],
                            scorers: [],
                        },
                    }],
                },
                {
                    caseId: 'text-diagnostic',
                    name: 'text diagnostic',
                    state: 'pending',
                    runnerDurationMs: 0,
                    sourceRef: 'eve://session/waiting',
                    diagnostics: {
                        turns: 0,
                        totalDurationMs: 0,
                        completionReason: 'parked',
                        completionDetail: 'waiting for human input',
                        score: 0,
                        turnDetails: [],
                        reactionsFired: [],
                        runtimePoliciesApplied: [],
                        recommendedTimeoutMs: 30_000,
                        warnings: [],
                        scorers: [],
                    },
                    evaluations: [{ score: 0 }],
                },
            ],
        }];

        const built = buildPathgradeReport({ threshold: 0.6, groups });

        expect(built.report).toMatchObject({
            overall_pass_rate: (1 + 0.5 + 0.25) / 3,
            status: 'fail',
            groups: [{
                task: 'future adapters',
                pass_rate: 2 / 3,
                pass_at_k: 1 - Math.pow(1 - 2 / 3, 3),
                pass_pow_k: Math.pow(2 / 3, 3),
                trace_file: 'traces/future-adapters.json',
            }],
        });
        expect(built.report.groups[0].trials).toHaveLength(3);
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('caseId');
        expect(built.report.groups[0].trials[0]).not.toHaveProperty('sourceRef');
        expect(built.summaries[0].diagnostics).toEqual([{
            caseName: 'assertion score',
            state: 'failed',
            report: expect.objectContaining({
                completionReason: 'assertion-failed',
                completionDetail: '3 of 4 assertions failed',
            }),
        }]);
    });
});
