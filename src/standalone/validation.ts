export class StandaloneConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StandaloneConfigurationError';
    }
}

const STANDALONE_VALUE_FLAGS = new Set([
    '-t',
    '--testNamePattern',
]);

function unsupported(value: string): StandaloneConfigurationError {
    return new StandaloneConfigurationError(
        `pathgrade standalone: ${value} is unsupported; ` +
        'the standalone runner allows only eval-file filters and -t/--testNamePattern; ' +
        'use project-local @wix/pathgrade for project runner compatibility',
    );
}

function isSupportedEvalFilter(value: string): boolean {
    return value.endsWith('.eval.ts');
}

export function validateStandaloneInvocation(input: {
    adapterName: string;
    runnerArgs: string[];
}): void {
    if (input.adapterName !== 'vitest') {
        throw unsupported(input.adapterName);
    }

    for (let index = 0; index < input.runnerArgs.length; index += 1) {
        const arg = input.runnerArgs[index];
        const [flag, inlineValue] = splitInlineValue(arg);

        if (STANDALONE_VALUE_FLAGS.has(flag)) {
            const value = inlineValue ?? input.runnerArgs[++index];
            if (!value || value.startsWith('-')) {
                throw unsupported(arg);
            }
            continue;
        }

        if (arg.startsWith('-') || !isSupportedEvalFilter(arg)) {
            throw unsupported(arg);
        }
    }
}

function splitInlineValue(arg: string): [string, string | undefined] {
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex === -1) return [arg, undefined];
    return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

export function assertStandalonePlatform(input: {
    nodeMajor: number;
    platform: NodeJS.Platform;
    arch: string;
}): void {
    const supported = (input.nodeMajor === 22 || input.nodeMajor === 24)
        && (input.platform === 'darwin' || input.platform === 'linux')
        && (input.arch === 'x64' || input.arch === 'arm64');
    if (supported) return;

    throw new StandaloneConfigurationError(
        `pathgrade standalone: unsupported runtime Node ${input.nodeMajor} ` +
        `on ${input.platform}/${input.arch}; supported runtimes are Node 22 or 24 ` +
        'on macOS, Linux, or WSL with x64 or arm64',
    );
}
