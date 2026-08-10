import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultPathgradeConfig } from '../src/config/pathgrade.js';
import { decodeStandaloneVitestPayload, STANDALONE_VITEST_PAYLOAD_ENV } from '../src/standalone/module-aliases.js';
import {
    createStandaloneVitestInvocationAdapter,
    resolveBundledVitestCli,
    type SpawnStandaloneVitestRequest,
} from '../src/standalone/vitest-invocation.js';

describe('standalone Vitest invocation', () => {
    it('uses Node, the bundled CLI, and the internal config', async () => {
        const calls: SpawnStandaloneVitestRequest[] = [];
        const config = {
            ...defaultPathgradeConfig(),
            reporter: 'json' as const,
            diagnostics: true,
            ci: { threshold: 0.8 },
        };
        const adapter = createStandaloneVitestInvocationAdapter({
            config,
            spawn: async (request) => {
                calls.push(request);
                return 0;
            },
            resolveRuntime: () => ({
                cliPath: '/tool/node_modules/vitest/vitest.mjs',
                entryPath: '/tool/node_modules/vitest/dist/index.js',
                version: '4.1.7',
            }),
            internalConfigPath: '/tool/dist/standalone/vitest-config.js',
            createTempDir: () => '/tmp/pathgrade-owned/run-1',
            removeTempDir: async () => {},
        });

        await adapter.run({
            cwd: '/repo',
            runnerArgs: ['--testNamePattern=smoke'],
            selectedFiles: ['one.eval.ts'],
            env: {},
        });

        expect(calls[0].command).toBe(process.execPath);
        expect(calls[0].argv).toEqual([
            '/tool/node_modules/vitest/vitest.mjs',
            'run',
            'one.eval.ts',
            '--testNamePattern=smoke',
            '--config',
            '/tool/dist/standalone/vitest-config.js',
        ]);
        expect(decodeStandaloneVitestPayload(
            calls[0].env[STANDALONE_VITEST_PAYLOAD_ENV],
        )).toEqual({
            root: '/repo',
            include: config.evals.include,
            exclude: config.evals.exclude,
            diagnostics: true,
            reporter: 'json',
            threshold: 0.8,
            cacheDir: '/tmp/pathgrade-owned/run-1',
        });
    });

    it.each([
        ['exit zero', async () => 0],
        ['nonzero exit', async () => 1],
        ['spawn failure', async () => { throw new Error('spawn failed'); }],
    ])('cleans its temporary directory after %s', async (_label, spawnImpl) => {
        const removed: string[] = [];
        const adapter = createStandaloneVitestInvocationAdapter({
            config: defaultPathgradeConfig(),
            spawn: spawnImpl,
            resolveRuntime: () => ({
                cliPath: '/tool/vitest.mjs',
                entryPath: '/tool/index.js',
                version: '4.1.7',
            }),
            internalConfigPath: '/tool/config.js',
            createTempDir: () => '/tmp/pathgrade-owned/run-cleanup',
            removeTempDir: async dir => { removed.push(dir); },
        });

        await adapter.run({
            cwd: '/repo',
            runnerArgs: [],
            env: {},
        }).catch(() => 1);

        expect(removed).toEqual(['/tmp/pathgrade-owned/run-cleanup']);
    });

    it('creates no cache or report output in the target cwd', async () => {
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-target-'));
        const adapter = createStandaloneVitestInvocationAdapter({
            config: defaultPathgradeConfig(),
            spawn: async () => 0,
        });

        await adapter.run({ cwd: target, runnerArgs: [], env: {} });

        for (const relative of [
            '.vite',
            'node_modules/.vite',
            'coverage',
            '.vitest-attachments',
            'vitest.blob',
        ]) {
            expect(fs.existsSync(path.join(target, relative))).toBe(false);
        }
    });

    it('resolves the exact package-owned Vitest runtime', () => {
        expect(resolveBundledVitestCli()).toMatchObject({
            version: '4.1.7',
            cliPath: expect.stringMatching(/vitest[\\/]vitest\.mjs$/),
            entryPath: expect.stringMatching(/vitest[\\/]dist[\\/]index\.js$/),
        });
    });
});
