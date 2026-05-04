/**
 * `pathgrade run --changed` — orchestration.
 *
 * Happy-path wrapper: computes the affected-eval selection, formats the
 * run-start summary, and spawns `vitest run <files> <extra-args>` with the
 * selected file list as positional args.
 *
 * Empty selection short-circuits: print "no affected evals" and exit 0
 * without invoking vitest (which would silently run the full suite with
 * zero positional args — a correctness bug we must not introduce).
 *
 * Git-resolution failures exit non-zero. The selection pipeline is the
 * only producer of the file list here.
 */

import * as fs from 'fs';
import { selectAffected } from '../affected/select.js';
import { resolveBaseRef, computeChangedFiles } from '../affected/git.js';
import { loadAffectedConfig } from '../affected/config.js';
import { writeSidecar } from '../affected/sidecar.js';
import { discoverEvalFiles } from './affected.js';
import type { SelectionResult } from '../affected/types.js';
import type { PathgradeRunArgs } from './run-args.js';

export interface SpawnVitestRequest {
    argv: string[];
}

export type SpawnVitest = (req: SpawnVitestRequest) => Promise<number> | number;

export interface RunChangedOptions {
    cwd: string;
    parsed: PathgradeRunArgs;
    /** Override for tests; default spawns `npx vitest` inheriting stdio. */
    spawnVitest?: SpawnVitest;
}

export async function runChanged(opts: RunChangedOptions): Promise<number> {
    const { cwd, parsed } = opts;
    const spawnVitest = opts.spawnVitest ?? defaultSpawnVitest;

    // 1. Change-set
    let baseRef: string;
    let changedFiles: string[];
    let baseRefLine: string | undefined;
    if (parsed.changedFilesPath) {
        try {
            changedFiles = readChangedFilesList(parsed.changedFilesPath);
        } catch (err) {
            process.stderr.write(
                `pathgrade run: could not read --changed-files: ${errMsg(err)}\n`,
            );
            return 1;
        }
        baseRef = 'explicit';
    } else if (parsed.since) {
        changedFiles = computeChangedFiles(parsed.since);
        baseRef = parsed.since;
        baseRefLine = `pathgrade: base = ${parsed.since} (--since)`;
    } else {
        const resolution = resolveBaseRef();
        if ('error' in resolution) {
            process.stderr.write(`${resolution.error}\n`);
            return 1;
        }
        const shortSha = resolution.sha.slice(0, 7);
        changedFiles = computeChangedFiles(resolution.sha);
        baseRef = `${resolution.base}@${shortSha}`;
        baseRefLine = `pathgrade: base = ${baseRef} (merge-base with HEAD)`;
    }

    // 2. Selection
    const evalFiles = discoverEvalFiles(cwd);
    const config = await loadAffectedConfig(cwd, {
        onWarning: w => {
            if (!parsed.quiet) process.stderr.write(`${w}\n`);
        },
    });

    let result: SelectionResult;
    try {
        result = selectAffected({
            evalFiles,
            changedFiles,
            repoRoot: cwd,
            baseRef,
            global: config.global,
        });
    } catch (err) {
        process.stderr.write(`pathgrade run: ${errMsg(err)}\n`);
        return 1;
    }

    // 3. Summary + spawn
    if (!parsed.quiet) {
        printRunStartSummary({
            baseRefLine,
            totalEvals: evalFiles.length,
            changedCount: changedFiles.length,
            result,
        });
    }

    // Persist the sidecar immediately — even on empty selection, so the
    // reporter (if invoked later by another workflow step) has a coherent
    // record. A subsequent plain `pathgrade run` clears it.
    await writeSidecar(cwd, result);

    if (result.selected.length === 0) {
        if (!parsed.quiet) {
            process.stderr.write(`pathgrade: no affected evals; nothing to run.\n`);
        }
        return 0;
    }

    const selectedFiles = result.selected.map(s => s.file);
    const argv = ['run', ...selectedFiles, ...parsed.vitestArgs];
    if (!parsed.quiet) {
        process.stderr.write(`→ vitest run ${selectedFiles.join(' ')}\n`);
    }
    return await spawnVitest({ argv });
}

interface SummaryInput {
    baseRefLine?: string;
    totalEvals: number;
    changedCount: number;
    result: SelectionResult;
}

function printRunStartSummary(input: SummaryInput): void {
    const { baseRefLine, totalEvals, changedCount, result } = input;
    if (baseRefLine) {
        process.stderr.write(`${baseRefLine}\n`);
    }
    process.stderr.write(`          changed files: ${changedCount}\n`);
    const globalLabel = result.globalMatch ? `\`${result.globalMatch}\`` : 'none';
    process.stderr.write(`          global matches: ${globalLabel}\n`);
    process.stderr.write(
        `          selected: ${result.selected.length} / ${totalEvals} evals\n`,
    );
    for (const entry of result.selected) {
        process.stderr.write(`            ${entry.file}\n`);
    }
    process.stderr.write(`          skipped: ${result.skipped.length}\n`);
    for (const w of result.warnings) {
        process.stderr.write(`          warning: ${w}\n`);
    }
    process.stderr.write(`\n`);
}

function readChangedFilesList(filePath: string): string[] {
    return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function defaultSpawnVitest(req: SpawnVitestRequest): Promise<number> {
    const { spawn } = await import('child_process');
    return await new Promise(resolve => {
        const child = spawn('npx', ['vitest', ...req.argv], {
            stdio: 'inherit',
            shell: true,
        });
        child.on('close', code => resolve(code ?? 0));
    });
}
