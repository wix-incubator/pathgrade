import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { buildDiagnosticsReport } from '../src/reporters/diagnostics.js';

vi.mock('fs-extra', () => {
    const mock = {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        writeFile: vi.fn(),
        pathExists: vi.fn().mockResolvedValue(false),
    };
    return { default: mock, ...mock };
});

function makeTestCase(opts: {
    name: string;
    state: 'passed' | 'failed';
    diagnostics: ReturnType<typeof buildDiagnosticsReport>;
}) {
    return {
        name: opts.name,
        parent: {
            type: 'suite',
            fullName: 'diagnostics flow',
        },
        module: {
            relativeModuleId: 'diagnostics.eval.ts',
        },
        meta: () => ({
            pathgrade: [{
                score: opts.diagnostics.score ?? 0,
                scorers: [],
                diagnostics: opts.diagnostics,
                trial: {
                    trial_id: 1,
                    reward: opts.diagnostics.score ?? 0,
                    scorer_results: [],
                    duration_ms: opts.diagnostics.totalDurationMs,
                    n_commands: 1,
                    input_tokens: 0,
                    output_tokens: 0,
                    session_log: [],
                },
            }],
        }),
        diagnostic: () => ({
            duration: opts.diagnostics.totalDurationMs,
        }),
        result: () => ({
            state: opts.state,
        }),
    };
}

describe('PathgradeReporter diagnostics integration', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        delete process.env.PATHGRADE_DIAGNOSTICS;
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.restoreAllMocks();
        delete process.env.PATHGRADE_DIAGNOSTICS;
    });

    it('prints summary diagnostics for passes and full diagnostics for failures', async () => {
        const passing = buildDiagnosticsReport({
            completionReason: 'until',
            score: 0.9,
            turnDetails: [
                { turn: 1, durationMs: 12_000, outputLines: 4, outputChars: 240 },
                { turn: 2, durationMs: 10_000, outputLines: 2, outputChars: 120 },
            ],
            log: [],
        });
        const failing = buildDiagnosticsReport({
            completionReason: 'timeout',
            score: 0.2,
            turnDetails: [
                { turn: 1, durationMs: 20_000, outputLines: 600, outputChars: 5_000 },
            ],
            scorers: [
                { name: 'judge', type: 'judge', score: 0, weight: 1, details: 'skipped (fail-fast)', status: 'skipped' },
            ],
            log: [],
        });

        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const reporter = new PathgradeReporter({ reporter: 'cli', timeout: 10 });

        await reporter.onTestRunEnd([{
            children: {
                allTests: () => [
                    makeTestCase({ name: 'passing eval', state: 'passed', diagnostics: passing }),
                    makeTestCase({ name: 'failing eval', state: 'failed', diagnostics: failing }),
                ],
            },
        }] as any);

        const output = consoleSpy.mock.calls.map((call: any) => String(call[0])).join('\n');
        expect(output).toContain('passing eval');
        expect(output).toContain('2 turns  22.0s  until  score 0.90');
        expect(output).toContain('failing eval');
        expect(output).toContain('Unified Diagnostics');
        expect(output).toContain('Timeout should be increased to ~50s');
    });

    it('persists diagnostics in JSON reports and forces full diagnostics for passes when enabled', async () => {
        const diagnostics = buildDiagnosticsReport({
            completionReason: 'completed',
            score: 1,
            turnDetails: [
                { turn: 1, durationMs: 8_000, outputLines: 3, outputChars: 200 },
            ],
            log: [],
        });

        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        writeJsonSpy.mockClear();
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.spyOn(process, 'cwd').mockReturnValue('/tmp/pathgrade-project');

        const reporter = new PathgradeReporter({ reporter: 'cli', diagnostics: true, timeout: 30 });

        await reporter.onTestRunEnd([{
            children: {
                allTests: () => [makeTestCase({ name: 'passing eval', state: 'passed', diagnostics })],
            },
        }] as any);

        // Trace file contains full trial data with diagnostics
        const traceCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && (p as string).includes('traces/'),
        );
        expect(traceCall).toBeDefined();
        const [, traceData] = traceCall!;
        expect(traceData[0].diagnostics).toMatchObject({
            completionReason: 'completed',
            recommendedTimeoutMs: 38_000,
        });
    });
});
