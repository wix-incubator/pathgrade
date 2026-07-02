import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
    getPathgradeDir,
    printReportSummary,
    readSidecar,
    runWithAdapter,
    type ResolvedPathgradeConfig,
    type RunnerInvocationAdapter,
} from '@wix/pathgrade/adapter-kit';
import { createJestAdapter } from './runner-adapter.js';

export interface SpawnJestRequest {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
}

export type SpawnJest = (req: SpawnJestRequest) => Promise<number> | number;

export function createJestInvocationAdapter(input: {
    config: ResolvedPathgradeConfig;
    spawnJest?: SpawnJest;
}): RunnerInvocationAdapter {
    const spawnJest = input.spawnJest ?? defaultSpawnJest;
    return {
        name: 'jest',
        async run(runInput) {
            const selection = await readSidecar(runInput.cwd, msg => {
                process.stderr.write(`[pathgrade] ${msg}\n`);
            }) ?? undefined;
            const include = runInput.selectedFiles && runInput.selectedFiles.length > 0
                ? runInput.selectedFiles
                : input.config.evals.include;
            const exclude = runInput.selectedFiles ? [] : input.config.evals.exclude;
            const discovered = await createJestAdapter().discover({
                cwd: runInput.cwd,
                include,
                exclude,
                selection,
            });

            if (discovered.units.length === 0) {
                return await runWithAdapter({
                    adapter: createJestAdapter({ results: { testResults: [] } }),
                    options: {
                        cwd: runInput.cwd,
                        discovery: {
                            cwd: runInput.cwd,
                            include,
                            exclude,
                            selection,
                        },
                        runnerArgs: [],
                        env: runInput.env,
                        artifactRoot: getPathgradeDir(runInput.cwd),
                        reporterMode: input.config.reporter ?? 'cli',
                        threshold: input.config.ci.threshold,
                        selection,
                        printSummary: summaries => {
                            printReportSummary(summaries, {
                                forceVerbose: input.config.diagnostics
                                    || runInput.env.PATHGRADE_DIAGNOSTICS === '1',
                            });
                        },
                        log: () => {
                            process.stdout.write(`\n  Results written to ${getPathgradeDir(runInput.cwd)}\n\n`);
                        },
                        onThresholdFailure: ({ overallPassRate, threshold }) => {
                            process.stdout.write(
                                `\n  CI THRESHOLD FAILED  avg score ${overallPassRate.toFixed(3)} < threshold ${threshold}\n\n`,
                            );
                        },
                    },
                });
            }

            return await spawnJest({
                cwd: runInput.cwd,
                env: runInput.env,
                argv: [
                    ...discovered.units.map(unit => unit.sourceRef).filter((sourceRef): sourceRef is string => typeof sourceRef === 'string'),
                    '--setupFilesAfterEnv',
                    resolveAdapterFile('setup'),
                    '--reporters',
                    'default',
                    '--reporters',
                    resolveReporterFile(),
                    ...runInput.runnerArgs,
                ],
            });
        },
    };
}

export function createPathgradeInvocationAdapter(input: {
    config: ResolvedPathgradeConfig;
}): RunnerInvocationAdapter {
    return createJestInvocationAdapter(input);
}

function resolveAdapterFile(name: 'setup'): string {
    return path.resolve(import.meta.dirname, `${name}.js`);
}

function resolveReporterFile(): string {
    return path.resolve(import.meta.dirname, 'reporter.cjs');
}

async function defaultSpawnJest(req: SpawnJestRequest): Promise<number> {
    const jestBinPath = resolveLocalJestBinPath(req.cwd);
    return await new Promise(resolve => {
        const child = spawn(process.execPath, [jestBinPath, ...req.argv], {
            stdio: 'inherit',
            env: req.env,
            cwd: req.cwd,
        });
        child.on('close', code => resolve(code ?? 0));
        child.on('error', () => resolve(1));
    });
}

export function resolveLocalJestBinPath(cwd: string): string {
    let packageJsonPath: string;
    try {
        const req = createRequire(path.join(cwd, 'package.json'));
        packageJsonPath = req.resolve('jest/package.json');
    } catch {
        throw new Error(
            'pathgrade: Jest adapter requires Jest to be installed in the project. Install it with `npm install --save-dev jest` or the equivalent for your package manager.',
        );
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>;
    };
    const bin = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.jest;

    if (!bin) {
        throw new Error(`pathgrade: could not find the Jest executable declared by ${packageJsonPath}.`);
    }

    return path.resolve(path.dirname(packageJsonPath), bin);
}
