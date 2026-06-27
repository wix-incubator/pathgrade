/**
 * Parse `pathgrade run` arguments.
 *
 * Recognized pathgrade-specific flags are consumed here; everything else
 * passes through to the selected runner. After a literal `--` separator,
 * all remaining args are forwarded verbatim.
 */

export interface PathgradeRunArgs {
    runnerArgs: string[];
    adapterName?: string;
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
    const runnerArgs: string[] = [];
    let forceDiagnostics = false;
    let forceVerbose = false;
    let changed = false;
    let quiet = false;
    let since: string | undefined;
    let changedFilesPath: string | undefined;
    let adapterName: string | undefined;
    let passthrough = false;

    for (const arg of args) {
        if (passthrough) {
            runnerArgs.push(arg);
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
        if (arg.startsWith('--adapter=')) { adapterName = arg.slice('--adapter='.length); continue; }
        if (arg.startsWith('--since=')) { since = arg.slice('--since='.length); continue; }
        if (arg.startsWith('--changed-files=')) {
            changedFilesPath = arg.slice('--changed-files='.length);
            continue;
        }
        runnerArgs.push(arg);
    }

    const warnings: string[] = [];
    if (!changed && since !== undefined) {
        warnings.push('--since has no effect without --changed; the flag is being ignored.');
    }
    if (!changed && changedFilesPath !== undefined) {
        warnings.push('--changed-files has no effect without --changed; the flag is being ignored.');
    }

    const base: PathgradeRunArgs = {
        runnerArgs,
        forceDiagnostics,
        forceVerbose,
        changed,
        quiet,
        adapterName,
        since,
        changedFilesPath,
    };
    return warnings.length > 0 ? { ...base, warnings } : base;
}
