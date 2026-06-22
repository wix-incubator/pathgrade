import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { writePathgradeArtifacts } from '../src/reporting/artifacts.js';
import type { PathgradeReportBuildResult } from '../src/reporting/types.js';

vi.mock('fs-extra', () => {
    const mock = {
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
        writeFile: vi.fn(),
        pathExists: vi.fn(),
    };
    return { default: mock, ...mock };
});

describe('runner-neutral report artifact writing', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes results, traces, and generated artifact gitignore under the artifact root', async () => {
        const fs = (await import('fs-extra')).default;
        vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
        vi.mocked(fs.pathExists).mockResolvedValue(false as never);
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.writeJson).mockResolvedValue(undefined);

        const built: PathgradeReportBuildResult = {
            report: {
                version: 1,
                timestamp: '2026-01-01T00:00:00.000Z',
                overall_pass_rate: 1,
                status: 'pass',
                groups: [],
            },
            traces: [
                {
                    traceFile: 'traces/group-a.json',
                    trials: [{
                        trial_id: 1,
                        reward: 1,
                        scorer_results: [],
                        duration_ms: 10,
                        n_commands: 0,
                        input_tokens: 0,
                        output_tokens: 0,
                        session_log: [],
                    }],
                },
            ],
            summaries: [],
            warnings: [],
        };

        const result = await writePathgradeArtifacts('/tmp/project/.pathgrade', built);

        expect(fs.ensureDir).toHaveBeenCalledWith(path.join('/tmp/project/.pathgrade', 'traces'));
        expect(fs.writeFile).toHaveBeenCalledWith(path.join('/tmp/project/.pathgrade', '.gitignore'), '*\n');
        expect(fs.writeJson).toHaveBeenCalledWith(
            path.join('/tmp/project/.pathgrade', 'traces/group-a.json'),
            built.traces[0].trials,
            { spaces: 2 },
        );
        expect(fs.writeJson).toHaveBeenCalledWith(
            path.join('/tmp/project/.pathgrade', 'results.json'),
            built.report,
            { spaces: 2 },
        );
        expect(result).toEqual({
            resultsPath: path.join('/tmp/project/.pathgrade', 'results.json'),
            traceFiles: ['traces/group-a.json'],
        });
    });
});
