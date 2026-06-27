import type { RunnerInvocationAdapter } from './invocation.js';

export interface SpawnVitestRequest {
    argv: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
}

export type SpawnVitest = (req: SpawnVitestRequest) => Promise<number> | number;

export function createVitestInvocationAdapter(input: {
    spawnVitest?: SpawnVitest;
} = {}): RunnerInvocationAdapter {
    const spawnVitest = input.spawnVitest ?? defaultSpawnVitest;
    return {
        name: 'vitest',
        async run(runInput) {
            if (runInput.selectedFiles && hasPassWithNoTests(runInput.runnerArgs)) {
                process.stderr.write(
                    'pathgrade run: --passWithNoTests cannot be used with pathgrade run --changed. ' +
                    'The command already exits 0 when no evals are selected; if selected evals resolve to no Vitest files, CI must fail.\n',
                );
                return 1;
            }

            const argv = [
                'run',
                ...(runInput.selectedFiles ?? []),
                ...runInput.runnerArgs,
            ];
            return await spawnVitest({
                argv,
                env: runInput.env,
                cwd: runInput.cwd,
            });
        },
    };
}

function hasPassWithNoTests(args: string[]): boolean {
    return args.some(arg => {
        if (arg === '--passWithNoTests') return true;
        if (!arg.startsWith('--passWithNoTests=')) return false;
        return arg.slice('--passWithNoTests='.length).toLowerCase() !== 'false';
    });
}

async function defaultSpawnVitest(req: SpawnVitestRequest): Promise<number> {
    const { spawn } = await import('child_process');
    return await new Promise(resolve => {
        const child = spawn('npx', ['vitest', ...req.argv], {
            stdio: 'inherit',
            env: req.env,
            cwd: req.cwd,
            shell: true,
        });
        child.on('close', code => resolve(code ?? 0));
    });
}
