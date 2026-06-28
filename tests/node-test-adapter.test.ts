import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createNodeTestAdapter } from '../src/adapters/node-test/runner-adapter.js';
import { runWithAdapter } from '../src/runners/orchestrator.js';

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
});
