import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createNodeTestAdapter } from '../src/adapters/node-test/runner-adapter.js';
import { buildPathgradeReport } from '../src/reporting/core.js';
import { buildNormalizedRunSnapshotFromReportGroups } from '../src/runners/model-builders.js';
import { runWithAdapter } from '../src/runners/orchestrator.js';
import { projectNormalizedRunSnapshotToReportInput } from '../src/runners/report-projection.js';

describe('node:test proof adapter', () => {
    it('runs a small non-Vitest eval and writes normal Pathgrade artifacts', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-node-test-adapter-'));
        const artifactRoot = path.join(cwd, '.pathgrade');
        const nodeTestApi = pathToFileURL(path.resolve('src/adapters/node-test/index.ts')).href;
        const sdkApi = pathToFileURL(path.resolve('src/sdk/index.ts')).href;

        await fs.outputFile(path.join(cwd, 'alpha.eval.ts'), `
export const __pathgradeMeta = {};
import { test } from '${nodeTestApi}';
import { createAgent, evaluate, check } from '${sdkApi}';

test('node proof evaluate', async () => {
    const agent = await createAgent({ workspace: process.cwd(), agent: 'codex' });
    await evaluate(agent, [check('always passes', () => true)]);
});
`);

        const exitCode = await runWithAdapter({
            adapter: createNodeTestAdapter(),
            options: {
                cwd,
                discovery: {
                    cwd,
                    include: ['**/*.eval.ts'],
                    exclude: [],
                },
                runnerArgs: [],
                env: process.env,
                artifactRoot,
                reporterMode: 'json',
            },
        });

        expect(exitCode).toBe(0);

        const report = await fs.readJson(path.join(artifactRoot, 'results.json'));
        expect(report).toMatchObject({
            version: 1,
            status: 'pass',
            overall_pass_rate: 1,
            groups: [{
                task: 'alpha.eval.ts',
                pass_rate: 1,
                trials: [{
                    reward: 1,
                    scorer_results: [{
                        scorer_type: 'deterministic',
                        score: 1,
                        details: 'passed',
                    }],
                }],
            }],
        });

        const trace = await fs.readJson(path.join(artifactRoot, 'traces', 'alpha-eval-ts.json'));
        expect(trace[0]).toMatchObject({
            name: 'node proof evaluate',
            reward: 1,
            diagnostics: {
                score: 1,
            },
        });
    });

    it('writes a compatible empty report when no node:test eval files are discovered', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-node-test-empty-'));
        const artifactRoot = path.join(cwd, '.pathgrade');

        const exitCode = await runWithAdapter({
            adapter: createNodeTestAdapter(),
            options: {
                cwd,
                discovery: {
                    cwd,
                    include: ['**/*.eval.ts'],
                    exclude: [],
                },
                runnerArgs: [],
                env: process.env,
                artifactRoot,
                reporterMode: 'json',
            },
        });

        expect(exitCode).toBe(0);
        await expect(fs.readJson(path.join(artifactRoot, 'results.json'))).resolves.toMatchObject({
            version: 1,
            status: 'pass',
            overall_pass_rate: 0,
            groups: [],
        });
    });

    it('uses local builder defaults for failed skipped pending and no-evaluation node:test cases', () => {
        const snapshot = buildNormalizedRunSnapshotFromReportGroups(
            { adapterName: 'node-test', status: 'completed', exitCode: 0 },
            [{
                groupName: 'node.eval.ts',
                cases: [
                    { caseId: 'passed', name: 'passed', state: 'passed', runnerDurationMs: 1 },
                    { caseId: 'failed', name: 'failed', state: 'failed', runnerDurationMs: 1 },
                    { caseId: 'skipped', name: 'skipped', state: 'skipped', runnerDurationMs: 0 },
                    { caseId: 'pending', name: 'pending', state: 'pending', runnerDurationMs: 0, evaluations: [{ score: 0.25 }] },
                ],
            }],
        );

        expect(snapshot.model.run.status).toBe('completed');
        expect(snapshot.model.cases).toEqual([
            expect.objectContaining({ id: 'passed', scoringPolicy: { kind: 'score', score: 1 }, attempts: [expect.objectContaining({ outcome: { kind: 'passed' } })] }),
            expect.objectContaining({ id: 'failed', scoringPolicy: { kind: 'score', score: 0 }, attempts: [expect.objectContaining({ outcome: { kind: 'failed' } })] }),
            expect.objectContaining({ id: 'skipped', scoringPolicy: { kind: 'non-scoring', reason: 'skipped' }, attempts: [expect.objectContaining({ outcome: { kind: 'not-run', reason: 'skipped' } })] }),
            expect.objectContaining({ id: 'pending', scoringPolicy: { kind: 'non-scoring', reason: 'pending' }, attempts: [expect.objectContaining({ outcome: { kind: 'not-run', reason: 'pending' } })] }),
        ]);

        const built = buildPathgradeReport(projectNormalizedRunSnapshotToReportInput(snapshot));

        expect(built.report).toMatchObject({
            overall_pass_rate: (1 + 0) / 2,
            status: 'fail',
            groups: [{ pass_rate: 1 / 2 }],
        });
        expect(JSON.stringify(built.report)).not.toContain('skipped');
    });
});
