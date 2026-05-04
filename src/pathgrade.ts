#!/usr/bin/env node

/**
 * pathgrade CLI — thin wrapper around vitest
 *
 * Usage:
 *   pathgrade run [-- vitest-args]   Run evals via vitest (loads .env, validates API keys)
 *   pathgrade init [--force]         Generate eval scaffolding
 *   pathgrade preview [browser]      View results (CLI default, or browser)
 */

import * as fs from 'fs';
import * as path from 'path';

import { spawn } from 'child_process';
import { runInit } from './commands/init.js';
import { runAnalyze } from './commands/analyze.js';
import { runValidate, runValidateAffected } from './commands/validate.js';
import { parsePathgradeRunArgs } from './commands/run-args.js';
import { runPreview } from './commands/preview.js';
import { runPreviewReactions } from './commands/preview-reactions.js';
import { runReport } from './commands/report.js';
import { runAffected } from './commands/affected.js';
import { runChanged } from './commands/run-changed.js';
import { clearSidecar } from './affected/sidecar.js';
import { fmt } from './utils/cli.js';
import { shutdown } from './utils/shutdown.js';

function loadDotenv(): void {
    const envPath = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;

    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
            process.env[key] = value;
        }
    }
}

function validateApiKeys(): void {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasClaude = !!process.env.HOME; // Claude CLI uses OS keychain, just check it exists

    if (!hasAnthropic && !hasOpenAI) {
        console.log(
            `\n  ${fmt.dim('warning:')} No API keys found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env or environment.\n` +
            `  ${fmt.dim('         Claude CLI auth (keychain) and Codex cached login (~/.codex/auth.json) may still work if installed.')}\n`,
        );
    }
}

async function main() {
    shutdown.install();
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === '--help' || command === '-h') {
        printHelp();
        return;
    }

    if (command === '--version' || command === '-v') {
        const pkg = JSON.parse(
            await import('fs').then(fs => fs.promises.readFile(
                new URL('../package.json', import.meta.url), 'utf-8'
            ))
        );
        console.log(pkg.version);
        return;
    }

    if (command === 'analyze') {
        const skillFlag = args.find(a => a.startsWith('--skill='));
        const dirFlag = args.find(a => a.startsWith('--dir='));
        const skill = skillFlag ? skillFlag.split('=')[1] : undefined;
        const dir = dirFlag ? dirFlag.split('=')[1] : undefined;
        const exitCode = await runAnalyze(process.cwd(), { skill, dir });
        process.exitCode = exitCode;
        return;
    }

    if (command === 'validate') {
        const validateArgs = args.slice(1);
        if (validateArgs.includes('--affected')) {
            const exitCode = await runValidateAffected(process.cwd());
            process.exitCode = exitCode;
            return;
        }
        const filePath = validateArgs[0];
        if (!filePath) {
            console.error('Usage: pathgrade validate <file.eval.ts>  |  pathgrade validate --affected');
            process.exitCode = 1;
            return;
        }
        const exitCode = await runValidate(path.resolve(filePath));
        process.exitCode = exitCode;
        return;
    }

    if (command === 'init') {
        const hasForce = args.includes('--force');
        await runInit(process.cwd(), { force: hasForce });
        return;
    }

    if (command === 'preview') {
        const previewArgs = args.slice(1);
        const mode = previewArgs.includes('browser') ? 'browser' : 'cli';
        const lastFlag = previewArgs.find(a => a.startsWith('--last='));
        const filterFlag = previewArgs.find(a => a.startsWith('--filter='));
        const last = lastFlag ? parseInt(lastFlag.split('=')[1], 10) : undefined;
        const filter = filterFlag ? filterFlag.split('=')[1] : undefined;
        await runPreview(process.cwd(), mode, undefined, { last, filter });
        return;
    }

    if (command === 'preview-reactions') {
        await runPreviewReactions(args.slice(1));
        return;
    }

    if (command === 'affected') {
        const affectedArgs = args.slice(1);
        const changedFilesFlag = affectedArgs.find(a => a.startsWith('--changed-files='));
        const sinceFlag = affectedArgs.find(a => a.startsWith('--since='));
        const changedFilesPath = changedFilesFlag
            ? changedFilesFlag.split('=').slice(1).join('=')
            : undefined;
        const since = sinceFlag ? sinceFlag.split('=').slice(1).join('=') : undefined;
        const explain = affectedArgs.includes('--explain');
        const json = affectedArgs.includes('--json');
        const exitCode = await runAffected({
            cwd: process.cwd(),
            changedFilesPath,
            since,
            explain,
            json,
        });
        process.exitCode = exitCode;
        return;
    }

    if (command === 'report') {
        const reportArgs = args.slice(1);
        const resultsPathFlag = reportArgs.find(a => a.startsWith('--results-path='));
        const commentIdFlag = reportArgs.find(a => a.startsWith('--comment-id='));
        const noComment = reportArgs.includes('--no-comment');
        const resultsPath = resultsPathFlag ? resultsPathFlag.split('=').slice(1).join('=') : undefined;
        const commentId = commentIdFlag ? commentIdFlag.split('=').slice(1).join('=') : undefined;
        await runReport(process.cwd(), { resultsPath, commentId, noComment });
        return;
    }

    if (command === 'run' || !command || command.startsWith('-')) {
        // pathgrade run [--changed [--since=…|--changed-files=…]] [--] [vitest-args]
        loadDotenv();
        validateApiKeys();

        const parsed = parsePathgradeRunArgs(command === 'run' ? args.slice(1) : args);

        for (const warning of parsed.warnings ?? []) {
            console.error(`pathgrade: ${warning}`);
        }

        if (parsed.changed) {
            const exitCode = await runChanged({
                cwd: process.cwd(),
                parsed,
                spawnVitest: ({ argv }) => new Promise<number>(resolve => {
                    const child = spawn('npx', ['vitest', ...argv], {
                        stdio: 'inherit',
                        env: {
                            ...process.env,
                            ...(parsed.forceDiagnostics ? { PATHGRADE_DIAGNOSTICS: '1' } : {}),
                            ...(parsed.forceVerbose ? { PATHGRADE_VERBOSE: '1' } : {}),
                        },
                        shell: true,
                    });
                    child.on('close', code => resolve(code ?? 0));
                }),
            });
            process.exitCode = exitCode;
            return;
        }

        // Plain `pathgrade run` — clear any stale selection sidecar from a
        // previous `--changed` run so it doesn't leak into this full-suite
        // run (the reporter would otherwise merge old metadata).
        await clearSidecar(process.cwd());

        const child = spawn('npx', ['vitest', 'run', ...parsed.vitestArgs], {
            stdio: 'inherit',
            env: {
                ...process.env,
                ...(parsed.forceDiagnostics ? { PATHGRADE_DIAGNOSTICS: '1' } : {}),
                ...(parsed.forceVerbose ? { PATHGRADE_VERBOSE: '1' } : {}),
            },
            shell: true,
        });

        child.on('close', (code) => {
            process.exitCode = code ?? 0;
        });
        return;
    }

    console.error(`Unknown command: ${command}`);
    console.error('Run "pathgrade --help" for usage.');
    process.exitCode = 1;
}

function printHelp() {
    console.log(`
  pathgrade - Evaluate AI agent skills with vitest

  Usage:
    pathgrade run [-- vitest-args]   Run evals (loads .env, delegates to vitest)
                     [--changed]               Run only evals affected by the current PR/change-set
                     [--since=<ref>]           Override base ref (implies git mode)
                     [--changed-files=<path>]  Use an explicit newline-delimited file list
                     [--quiet]                 Suppress the run-start summary
                     [--verbose|-v]            Stream live per-turn events to stderr during the run
    pathgrade init [--force]         Generate eval scaffolding
    pathgrade analyze [--skill=X]    Analyze skills and output JSON
    pathgrade validate <file>        Validate an .eval.ts file
    pathgrade validate --affected    Strict: every eval must be anchored or have valid __pathgradeMeta
    pathgrade preview [browser]      View results (CLI default, or browser)
                     [--last=N]     Show only the N most recent reports
                     [--filter=X]   Filter reports by test name (substring)
    pathgrade preview-reactions      Preview reactions against a snapshot
    pathgrade report                 Format .pathgrade/results.json as a markdown PR comment
                     [--results-path=<path>]   Override results.json location
                     [--no-comment]            Print markdown to stdout; do not post
                     [--comment-id=<id>]       Override comment marker (default: $GITHUB_WORKFLOW:$GITHUB_JOB)
    pathgrade affected               Print eval files affected by a change-set (one per line)
                     [--since=<ref>]           Diff <ref>...HEAD (overrides git auto-detection)
                     [--changed-files=<path>]  Newline-delimited repo-relative file list
                     [--explain]               Print human-readable per-eval decision to stderr
                     [--json]                  Emit structured JSON (snake_case) to stdout

  Environment:
    PATHGRADE_AGENT=codex            Override agent for all trials
    ANTHROPIC_API_KEY                API key for Claude
    OPENAI_API_KEY                   API key for Codex (optional if Codex CLI is already logged in)

  Examples:
    pathgrade run                    # run all *.eval.ts files
    pathgrade run --diagnostics      # print full diagnostics for passing evals too
    pathgrade run --verbose          # stream per-turn events live to stderr while evals run
    pathgrade run -- --grep superlint   # filter by test name
    pathgrade init                   # scaffold eval files
    pathgrade preview browser        # open web UI
    pathgrade preview-reactions --snapshot ./pathgrade-debug/run-snapshot.json --reactions ./reactions.ts
`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
