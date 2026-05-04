import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs-extra', () => {
    const mock = {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        writeFile: vi.fn(),
        pathExists: vi.fn().mockResolvedValue(false),
    };
    return { default: mock, ...mock };
});

function makeTestCase(overrides?: { sessionLog?: any[]; conversation?: any }) {
    return {
        name: 'trial 1',
        parent: {
            type: 'suite',
            fullName: 'fix the bug',
        },
        module: {
            relativeModuleId: 'fix-bug.eval.ts',
        },
        meta: () => ({
            pathgrade: [{
                score: 0.75,
                scorers: [
                    { name: 'artifact', type: 'check', score: 1, weight: 1, details: 'passed' },
                    { name: 'quality', type: 'judge', score: 0.5, weight: 1, details: 'solid' },
                ],
                trial: {
                    trial_id: 1,
                    reward: 0.75,
                    scorer_results: [
                        { scorer_type: 'deterministic', score: 1, weight: 1, details: 'passed' },
                        { scorer_type: 'llm_rubric', score: 0.5, weight: 1, details: 'solid' },
                    ],
                    duration_ms: 0,
                    n_commands: 2,
                    input_tokens: 12,
                    output_tokens: 18,
                    session_log: overrides?.sessionLog ?? [
                        { type: 'command', timestamp: '2026-01-01T00:00:00.000Z', command: 'ls', stdout: '', stderr: '', exitCode: 0 },
                    ],
                    conversation: overrides?.conversation,
                },
            }],
        }),
        diagnostic: () => ({
            duration: 1500,
        }),
        result: () => ({
            state: 'passed',
        }),
    };
}

describe('PathgradeReporter consolidated output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    beforeEach(() => {
        consoleSpy.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes consolidated results.json to .pathgrade/ in the project directory', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        const testModules = [{
            children: { allTests: () => [makeTestCase()] },
        }] as any;

        await reporter.onTestRunEnd(testModules);

        // Should write results.json to .pathgrade/
        const resultsCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        expect(resultsCall).toBeDefined();
        const [resultsPath, report] = resultsCall!;
        expect(resultsPath).toBe(path.join('/tmp/my-project', '.pathgrade', 'results.json'));

        // Consolidated report schema
        expect(report).toMatchObject({
            version: 1,
            overall_pass_rate: expect.any(Number),
            status: expect.stringMatching(/^(pass|fail)$/),
            groups: expect.arrayContaining([
                expect.objectContaining({
                    task: 'fix-bug.eval.ts > fix the bug',
                    trace_file: expect.stringContaining('traces/'),
                }),
            ]),
        });
        expect(report.timestamp).toBeDefined();

        cwdSpy.mockRestore();
    });

    it('writes trace files with full trial data including session_log', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        const testModules = [{
            children: { allTests: () => [makeTestCase()] },
        }] as any;

        await reporter.onTestRunEnd(testModules);

        // Should write trace file to .pathgrade/traces/
        const traceCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && (p as string).includes('traces/'),
        );
        expect(traceCall).toBeDefined();
        const [tracePath, traceData] = traceCall!;
        expect(tracePath).toMatch(/\.pathgrade\/traces\/.*\.json$/);

        // Trace should contain full trial data with session_log
        expect(traceData).toBeInstanceOf(Array);
        expect(traceData[0].session_log).toBeDefined();
        expect(traceData[0].session_log.length).toBeGreaterThan(0);

        cwdSpy.mockRestore();
    });

    it('strips session_log and conversation from trials in consolidated results.json', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);

        const conversation = {
            turns: [{ turn_number: 1, user_message: 'hi', assistant_message: 'hello' }],
            total_turns: 1,
            completion_reason: 'done_phrase',
        };
        const reporter = new PathgradeReporter({ reporter: 'cli' });
        const testModules = [{
            children: { allTests: () => [makeTestCase({ conversation })] },
        }] as any;

        await reporter.onTestRunEnd(testModules);

        const resultsCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        const [, report] = resultsCall!;
        const trial = report.groups[0].trials[0];
        expect(trial.session_log).toBeUndefined();
        expect(trial.conversation).toBeUndefined();
        // But reward and scorer_results should still be present
        expect(trial.reward).toBe(0.75);
        expect(trial.scorer_results).toBeDefined();

        cwdSpy.mockRestore();
    });

    it('creates .pathgrade/.gitignore with * content', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        vi.mocked(fs.pathExists).mockResolvedValue(false as any);
        const writeFileSpy = vi.mocked(fs.writeFile).mockResolvedValue(undefined);

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        const testModules = [{
            children: { allTests: () => [makeTestCase()] },
        }] as any;

        await reporter.onTestRunEnd(testModules);

        const gitignoreCall = writeFileSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && (p as string).endsWith('.gitignore'),
        );
        expect(gitignoreCall).toBeDefined();
        expect(gitignoreCall![0]).toBe(path.join('/tmp/my-project', '.pathgrade', '.gitignore'));
        expect(gitignoreCall![1]).toBe('*\n');

        cwdSpy.mockRestore();
    });

    it('populates skills_used from trial tool events', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        writeJsonSpy.mockClear();

        const skillSessionLog = [
            {
                type: 'tool_event' as const,
                timestamp: '2026-01-01T00:00:00.000Z',
                tool_event: {
                    action: 'use_skill' as const,
                    provider: 'claude' as const,
                    providerToolName: 'Skill',
                    summary: 'use_skill via Skill',
                    confidence: 'high' as const,
                    rawSnippet: '...',
                    skillName: 'tdd',
                },
            },
            {
                type: 'tool_event' as const,
                timestamp: '2026-01-01T00:00:01.000Z',
                tool_event: {
                    action: 'use_skill' as const,
                    provider: 'claude' as const,
                    providerToolName: 'Read',
                    summary: 'use_skill via Read',
                    confidence: 'high' as const,
                    rawSnippet: '...',
                    skillName: 'debugging',
                },
            },
        ];

        const testCase = {
            name: 'trial 1',
            parent: { type: 'suite', fullName: 'skill test' },
            module: { relativeModuleId: 'skill.eval.ts' },
            meta: () => ({
                pathgrade: [{
                    score: 0.75,
                    scorers: [],
                    trial: {
                        trial_id: 1,
                        reward: 0.75,
                        scorer_results: [],
                        duration_ms: 0,
                        n_commands: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        session_log: skillSessionLog,
                    },
                }],
            }),
            diagnostic: () => ({ duration: 1000 }),
            result: () => ({ state: 'passed' }),
        };

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        const testModules = [{
            children: { allTests: () => [testCase] },
        }] as any;

        await reporter.onTestRunEnd(testModules);

        // Find the results.json write (consolidated report)
        const resultsCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        const [, report] = resultsCall!;
        const group = report.groups[0];
        expect(group.skills_used).toEqual(['tdd', 'debugging']);

        // Find the trace file write — full trial should have skills_used
        const traceCall = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && (p as string).includes('traces/'),
        );
        expect(traceCall![1][0].skills_used).toEqual(['tdd', 'debugging']);

        cwdSpy.mockRestore();
    });
});
