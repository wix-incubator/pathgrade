import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
    execSync: vi.fn(),
}));

vi.mock('fs-extra', () => {
    const mock = {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        writeFile: vi.fn(),
        pathExists: vi.fn().mockResolvedValue(false),
        readJSON: vi.fn(),
    };
    return { default: mock, ...mock };
});

function makeTestCase(score: number, state: 'passed' | 'failed' = 'passed') {
    return {
        name: 'trial 1',
        parent: { type: 'suite', fullName: 'mode flow' },
        module: { relativeModuleId: 'mode.eval.ts' },
        meta: () => ({
            pathgrade: [{
                score,
                trial: {
                    trial_id: 1,
                    reward: score,
                    scorer_results: [],
                    duration_ms: 10,
                    n_commands: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    session_log: [],
                },
            }],
        }),
        diagnostic: () => ({ duration: 10 }),
        result: () => ({ state }),
    };
}

describe('PathgradeReporter modes and threshold behavior', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let originalExitCode: typeof process.exitCode;

    beforeEach(async () => {
        vi.clearAllMocks();
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mode-project');
        originalExitCode = process.exitCode;
        process.exitCode = undefined;

        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        vi.mocked(fs.pathExists).mockResolvedValue(false as never);
        vi.mocked(fs.readJSON).mockReset();
    });

    afterEach(() => {
        process.exitCode = originalExitCode;
        cwdSpy.mockRestore();
        vi.restoreAllMocks();
    });

    it('browser mode writes fresh artifacts before opening the viewer', async () => {
        const fs = (await import('fs-extra')).default;
        const childProcess = await import('child_process');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');

        const reporter = new PathgradeReporter({ reporter: 'browser' });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase(1)] } }] as any);

        expect(fs.writeJson).toHaveBeenCalledWith(
            '/tmp/mode-project/.pathgrade/results.json',
            expect.objectContaining({ overall_pass_rate: 1 }),
            { spaces: 2 },
        );
        expect(vi.mocked(fs.writeJson).mock.invocationCallOrder.at(-1)!)
            .toBeLessThan(vi.mocked(childProcess.execSync).mock.invocationCallOrder[0]);
        expect(logSpy.mock.calls.map(call => String(call[0])).join('\n')).toContain('Opened viewer in browser');
    });

    it('json mode writes artifacts without CLI summary or browser opening', async () => {
        const childProcess = await import('child_process');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');

        const reporter = new PathgradeReporter({ reporter: 'json' });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase(1)] } }] as any);

        const output = logSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(output).not.toContain('pathgrade summary');
        expect(childProcess.execSync).not.toHaveBeenCalled();
    });

    it('uses overall pass rate for CI threshold failure and exit code', async () => {
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');

        const reporter = new PathgradeReporter({ reporter: 'json', ci: { threshold: 0.8 } });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase(0.25, 'passed')] } }] as any);

        const output = logSpy.mock.calls.map(call => String(call[0])).join('\n');
        expect(output).toContain('CI THRESHOLD FAILED');
        expect(output).toContain('avg score 0.250 < threshold 0.8');
        expect(process.exitCode).toBe(1);
    });
});
