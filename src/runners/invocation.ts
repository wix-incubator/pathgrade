export interface RunnerInvocationAdapter {
    readonly name: string;
    run(input: RunnerInvocationInput): Promise<number>;
}

export interface RunnerInvocationInput {
    cwd: string;
    runnerArgs: string[];
    selectedFiles?: string[];
    env: NodeJS.ProcessEnv;
}
