import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn as spawnChild } from 'node:child_process';
import type { ResolvedPathgradeConfig } from '../config/pathgrade.js';
import type { RunnerInvocationAdapter } from '../runners/invocation.js';
import {
    encodeStandaloneVitestPayload,
    selectStandaloneEsmExportTarget,
    STANDALONE_VITEST_PAYLOAD_ENV,
    type StandaloneVitestPayload,
} from './module-aliases.js';
import { classifyStandaloneVitestFailure } from './diagnostics.js';
import { buildStandaloneRunProvenance, encodeStandaloneRunProvenance, STANDALONE_PROVENANCE_ENV } from './provenance.js';

const BUNDLED_VITEST_VERSION = '4.1.7';
const STDERR_LIMIT_BYTES = 64 * 1024;

export interface BundledVitestRuntime {
    cliPath: string;
    version: string;
    entryPath: string;
}

export interface SpawnStandaloneVitestRequest {
    command: string;
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
}

export interface SpawnStandaloneVitestResult {
    exitCode: number;
    stderr?: string;
}

export type SpawnStandaloneVitest = (
    request: SpawnStandaloneVitestRequest,
) => Promise<number | SpawnStandaloneVitestResult> | number | SpawnStandaloneVitestResult;

export function resolveBundledVitestCli(): BundledVitestRuntime {
    try {
        const require = createRequire(import.meta.url);
        const packageJsonPath = require.resolve('vitest/package.json');
        const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf8'),
        ) as {
            version?: string;
            bin?: string | Record<string, string>;
            exports?: Record<string, unknown>;
        };
        const bin = typeof packageJson.bin === 'string'
            ? packageJson.bin
            : packageJson.bin?.vitest;
        const entry = selectStandaloneEsmExportTarget(packageJson.exports?.['.']);
        if (packageJson.version !== BUNDLED_VITEST_VERSION || !bin || !entry) {
            throw new Error('unexpected bundled Vitest metadata');
        }
        const packageRoot = path.dirname(packageJsonPath);
        return {
            cliPath: path.resolve(packageRoot, bin),
            version: packageJson.version,
            entryPath: path.resolve(packageRoot, entry),
        };
    } catch {
        throw new Error(
            `pathgrade standalone: bundled Vitest ${BUNDLED_VITEST_VERSION} ` +
            'could not be resolved; this is a Pathgrade packaging defect',
        );
    }
}

export function createStandaloneVitestInvocationAdapter(input: {
    config: ResolvedPathgradeConfig;
    spawn?: SpawnStandaloneVitest;
    resolveRuntime?: () => BundledVitestRuntime;
    internalConfigPath?: string;
    createTempDir?: () => Promise<string> | string;
    removeTempDir?: (directory: string) => Promise<void> | void;
}): RunnerInvocationAdapter {
    const spawn = input.spawn ?? defaultSpawnStandaloneVitest;
    const resolveRuntime = input.resolveRuntime ?? resolveBundledVitestCli;
    const internalConfigPath = input.internalConfigPath
        ?? path.resolve(import.meta.dirname, 'vitest-config.js');
    const createTempDir = input.createTempDir ?? defaultCreateTempDir;
    const removeTempDir = input.removeTempDir ?? defaultRemoveTempDir;

    return {
        name: 'vitest',
        async run(runInput): Promise<number> {
            const cacheDir = path.resolve(await createTempDir());
            try {
                const runtime = resolveRuntime();
                const payload = buildPayload(input.config, runInput, cacheDir);
                const provenance = await buildStandaloneRunProvenance();
                const result = await spawn({
                    command: process.execPath,
                    argv: [
                        runtime.cliPath,
                        'run',
                        ...(runInput.selectedFiles ?? []),
                        ...runInput.runnerArgs,
                        '--config',
                        internalConfigPath,
                    ],
                    cwd: runInput.cwd,
                    env: {
                        ...runInput.env,
                        [STANDALONE_VITEST_PAYLOAD_ENV]:
                            encodeStandaloneVitestPayload(payload),
                        [STANDALONE_PROVENANCE_ENV]: encodeStandaloneRunProvenance(provenance),
                    },
                });
                const normalized = typeof result === 'number'
                    ? { exitCode: result, stderr: undefined }
                    : result;
                if (normalized.exitCode !== 0 && normalized.stderr) {
                    const classified = classifyStandaloneVitestFailure(normalized.stderr);
                    if (classified) process.stderr.write(`${classified.message}\n`);
                }
                return normalized.exitCode;
            } finally {
                await removeTempDir(cacheDir);
            }
        },
    };
}

function buildPayload(
    config: ResolvedPathgradeConfig,
    runInput: Parameters<RunnerInvocationAdapter['run']>[0],
    cacheDir: string,
): StandaloneVitestPayload {
    return {
        root: path.resolve(runInput.cwd),
        include: [...config.evals.include],
        exclude: [...config.evals.exclude],
        diagnostics:
            config.diagnostics || runInput.env.PATHGRADE_DIAGNOSTICS === '1',
        ...(config.reporter === undefined ? {} : { reporter: config.reporter }),
        ...(config.ci.threshold === undefined ? {} : { threshold: config.ci.threshold }),
        cacheDir,
    };
}

async function defaultCreateTempDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'pathgrade-standalone-'));
}

async function defaultRemoveTempDir(directory: string): Promise<void> {
    await fs.promises.rm(directory, { recursive: true, force: true });
}

async function defaultSpawnStandaloneVitest(
    request: SpawnStandaloneVitestRequest,
): Promise<SpawnStandaloneVitestResult> {
    return await new Promise((resolve, reject) => {
        const child = spawnChild(request.command, request.argv, {
            stdio: ['inherit', 'pipe', 'pipe'],
            cwd: request.cwd,
            env: request.env,
        });
        let retainedStderr: Buffer = Buffer.alloc(0);

        child.stdout?.on('data', (chunk: Buffer | string) => {
            process.stdout.write(chunk);
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            process.stderr.write(chunk);
            retainedStderr = retainTail(retainedStderr, chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({
                exitCode: code ?? 1,
                stderr: retainedStderr.toString('utf8'),
            });
        });
    });
}

function retainTail(previous: Buffer, chunk: Buffer | string): Buffer {
    const next = Buffer.concat([
        previous,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    return next.length <= STDERR_LIMIT_BYTES
        ? next
        : next.subarray(next.length - STDERR_LIMIT_BYTES);
}
