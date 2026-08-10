import type { Writable } from 'node:stream';

export interface StandaloneTheme {
    color: boolean;
    interactive: boolean;
    bold(value: string): string;
    dim(value: string): string;
    green(value: string): string;
    red(value: string): string;
    cyan(value: string): string;
    yellow(value: string): string;
    magenta(value: string): string;
}

type ColorStream = Writable & {
    isTTY?: boolean;
    getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
};

export function createStandaloneTheme(
    stream: ColorStream = process.stdout,
    env: NodeJS.ProcessEnv = process.env,
): StandaloneTheme {
    const color = colorEnabled(stream, env);
    const interactive = stream.isTTY === true
        && env.TERM !== 'dumb'
        && !env.CI
        && env.PATHGRADE_QUIET !== '1';
    const apply = (ansi: number) => (value: string) => color
        ? `\x1b[${ansi}m${value}\x1b[0m`
        : value;
    return {
        color,
        interactive,
        bold: apply(1),
        dim: apply(2),
        red: apply(31),
        green: apply(32),
        yellow: apply(33),
        cyan: apply(36),
        magenta: apply(35),
    };
}

function colorEnabled(stream: ColorStream, env: NodeJS.ProcessEnv): boolean {
    if (env.FORCE_COLOR === '0') return false;
    if (env.FORCE_COLOR !== undefined) return true;
    if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) return false;
    if (stream.getColorDepth) return stream.getColorDepth(env) > 1;
    return stream.isTTY === true && env.TERM !== 'dumb';
}
