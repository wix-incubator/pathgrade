export const PATHGRADE_STANDALONE_ENV = 'PATHGRADE_STANDALONE' as const;

export function isStandaloneMode(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[PATHGRADE_STANDALONE_ENV] === '1';
}

export function parseStandaloneCommand(
    args: readonly string[],
): { standalone: boolean; args: string[] } {
    if (args[0] !== 'standalone') {
        return { standalone: false, args: [...args] };
    }

    const nested = args.slice(1);
    return {
        standalone: true,
        args: nested.length === 0 ? ['run'] : [...nested],
    };
}
