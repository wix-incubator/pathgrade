import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs-extra', () => {
    const mock = {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        writeFile: vi.fn(),
        pathExists: vi.fn(),
        readJSON: vi.fn(),
        remove: vi.fn(),
    };
    return { default: mock, ...mock };
});

function makeTestCase() {
    return {
        name: 'trial 1',
        parent: { type: 'suite', fullName: 'fix the bug' },
        module: { relativeModuleId: 'fix-bug.eval.ts' },
        meta: () => ({
            pathgrade: [{
                score: 1,
                scorers: [],
                trial: {
                    trial_id: 1,
                    reward: 1,
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
        result: () => ({ state: 'passed' }),
    };
}

describe('PathgradeReporter — selection sidecar merge (Issue 11)', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.writeJson).mockClear();
        vi.mocked(fs.readJSON).mockReset();
        vi.mocked(fs.pathExists).mockReset();
    });

    afterEach(() => {
        consoleSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('merges a valid sidecar into results.json as the `selection` field', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/p1');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);

        const sidecar = {
            base_ref: 'origin/main@abc1234',
            changed_files_count: 3,
            selected: ['skills/alpha/a.eval.ts'],
            skipped: [{ file: 'skills/beta/b.eval.ts', reason: 'no-matching-deps' }],
        };
        vi.mocked(fs.pathExists).mockResolvedValue(true as any);
        vi.mocked(fs.readJSON).mockResolvedValue(sidecar);

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase()] } }] as any);

        const call = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        expect(call).toBeDefined();
        const [, report] = call!;
        expect((report as any).selection).toEqual(sidecar);
        cwdSpy.mockRestore();
    });

    it('leaves selection absent when sidecar does not exist', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/p2');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        vi.mocked(fs.pathExists).mockImplementation(async (p: any) => {
            // Only return false for the sidecar; leave other lookups unspecified.
            if (typeof p === 'string' && p.endsWith('selection.json')) return false;
            return false;
        });
        vi.mocked(fs.readJSON).mockReset();

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase()] } }] as any);

        const call = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        const [, report] = call!;
        expect('selection' in (report as any)).toBe(false);
        cwdSpy.mockRestore();
    });

    it('tolerates a malformed sidecar (warns, writes results.json without selection)', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/p3');
        const { PathgradeReporter } = await import('../src/plugin/reporter.js');
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        const writeJsonSpy = vi.mocked(fs.writeJson).mockResolvedValue(undefined);
        vi.mocked(fs.pathExists).mockResolvedValue(true as any);
        vi.mocked(fs.readJSON).mockRejectedValue(new Error('unexpected token'));

        const reporter = new PathgradeReporter({ reporter: 'cli' });
        await reporter.onTestRunEnd([{ children: { allTests: () => [makeTestCase()] } }] as any);

        const call = writeJsonSpy.mock.calls.find(
            ([p]) => typeof p === 'string' && p.endsWith('results.json'),
        );
        const [, report] = call!;
        expect('selection' in (report as any)).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
        cwdSpy.mockRestore();
    });
});

// Silence unused import warning — path is useful for future reference.
void path;
