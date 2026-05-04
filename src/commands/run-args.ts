/**
 * Parse `pathgrade run` arguments.
 *
 * Recognized pathgrade-specific flags are consumed here; everything else
 * passes through to vitest. After a literal `--` separator, all remaining
 * args are forwarded verbatim (vitest uses `--` the same way).
 */

export interface PathgradeRunArgs {
    vitestArgs: string[];
    forceDiagnostics: boolean;
    forceVerbose: boolean;
    changed: boolean;
    quiet: boolean;
    since?: string;
    changedFilesPath?: string;
    /**
     * Non-fatal argument-shape warnings (e.g. `--since` without `--changed`).
     * Callers should surface these to the user on stderr before dispatch.
     */
    warnings?: string[];
}

export function parsePathgradeRunArgs(args: string[]): PathgradeRunArgs {
    const vitestArgs: string[] = [];
    let forceDiagnostics = false;
    let forceVerbose = false;
    let changed = false;
    let quiet = false;
    let since: string | undefined;
    let changedFilesPath: string | undefined;
    let passthrough = false;

    for (const arg of args) {
        if (passthrough) {
            vitestArgs.push(arg);
            continue;
        }
        if (arg === '--') {
            passthrough = true;
            continue;
        }
        if (arg === '--diagnostics') { forceDiagnostics = true; continue; }
        if (arg === '--verbose' || arg === '-v') { forceVerbose = true; continue; }
        if (arg === '--changed') { changed = true; continue; }
        if (arg === '--quiet') { quiet = true; continue; }
        if (arg.startsWith('--since=')) { since = arg.slice('--since='.length); continue; }
        if (arg.startsWith('--changed-files=')) {
            changedFilesPath = arg.slice('--changed-files='.length);
            continue;
        }
        vitestArgs.push(arg);
    }

    const warnings: string[] = [];
    if (!changed && since !== undefined) {
        warnings.push('--since has no effect without --changed; the flag is being ignored.');
    }
    if (!changed && changedFilesPath !== undefined) {
        warnings.push('--changed-files has no effect without --changed; the flag is being ignored.');
    }

    const base: PathgradeRunArgs = {
        vitestArgs,
        forceDiagnostics,
        forceVerbose,
        changed,
        quiet,
        since,
        changedFilesPath,
    };
    return warnings.length > 0 ? { ...base, warnings } : base;
}
