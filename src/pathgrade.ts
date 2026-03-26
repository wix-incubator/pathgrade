#!/usr/bin/env node

/**
 * pathgrade CLI
 *
 * Usage:
 *   pathgrade                     Run all eval tasks from eval.yaml
 *   pathgrade init                Generate eval.yaml from detected skills
 *   pathgrade preview [browser]   View results (CLI default, or browser)
 *   pathgrade <task-name>         Run a specific eval
 *
 * Options:
 *   --trials=N         Override trial count
 *   --parallel=N       Run trials concurrently
 *   --validate         Run reference solutions to verify graders
 *   --ci               CI mode: exit non-zero if below threshold
 *   --threshold=0.8    Pass rate threshold for --ci
 *   --preview          Open results after running
 */

import { runInit } from './commands/init';
import { runEvals } from './commands/run';
import { runPreview } from './commands/preview';
import { fmt } from './utils/cli';
import * as os from 'os';
import * as path from 'path';

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const cwd = process.cwd();

    // Parse global flags
    const getFlag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
    const hasFlag = (name: string) => args.includes(`--${name}`);

    if (command === '--help' || command === '-h') {
        printHelp();
        return;
    }

    if (command === '--version' || command === '-v') {
        const pkg = require('../package.json');
        console.log(pkg.version);
        return;
    }

    if (command === 'init') {
        await runInit(cwd, { force: hasFlag('force') });
        return;
    }

    if (command === 'preview') {
        const mode = args[1] === 'browser' ? 'browser' : 'cli';
        const outputDir = getFlag('output') || path.join(os.tmpdir(), 'pathgrade');
        await runPreview(cwd, mode, outputDir);
        return;
    }

    // Default: run evals
    const taskName = command && !command.startsWith('-') ? command : undefined;
    const openPreview = hasFlag('preview');

    // Preset modes (can be overridden by --trials)
    let preset: 'smoke' | 'reliable' | 'regression' | undefined;
    let presetTrials: number | undefined;
    if (hasFlag('smoke')) {
        preset = 'smoke';
        presetTrials = 5;
    } else if (hasFlag('reliable')) {
        preset = 'reliable';
        presetTrials = 15;
    } else if (hasFlag('regression')) {
        preset = 'regression';
        presetTrials = 30;
    }

    const explicitTrials = getFlag('trials') ? parseInt(getFlag('trials')!) : undefined;

    // Resolve eval filter: --eval flag, deprecated --task flag, or positional arg
    let evalFilter: string | undefined;
    if (getFlag('eval')) {
        evalFilter = getFlag('eval');
    } else if (getFlag('task')) {
        console.log(`  ${fmt.dim('note:')} --task is deprecated, use --eval instead\n`);
        evalFilter = getFlag('task');
    } else if (taskName) {
        evalFilter = taskName;
    }

    const outputDir = getFlag('output') || path.join(os.tmpdir(), 'pathgrade');

    await runEvals(cwd, {
        eval: evalFilter,
        trials: explicitTrials ?? presetTrials,
        parallel: getFlag('parallel') ? parseInt(getFlag('parallel')!) : undefined,
        validate: hasFlag('validate'),
        ci: hasFlag('ci'),
        threshold: getFlag('threshold') ? parseFloat(getFlag('threshold')!) : undefined,
        preset,
        agent: getFlag('agent'),
        grader: getFlag('grader'),
        output: outputDir,
    });

    if (openPreview) {
        await runPreview(cwd, 'cli', outputDir);
    }
}

function printHelp() {
    console.log(`
  pathgrade - The easiest way to evaluate your Agent Skills

  Usage:
    pathgrade                     Run all evals from eval.yaml
    pathgrade init [--force]      Generate eval.yaml (--force to overwrite)
    pathgrade preview [browser]   View results (CLI default, or browser)
    pathgrade <eval-name>         Run a specific eval

  Presets:
    --smoke            Quick smoke test (5 trials, reports pass@k)
    --reliable         Reliable pass rate (15 trials, reports mean reward)
    --regression       High-confidence regression (30 trials, reports pass^k)

  Options:
    --eval=NAME[,NAME] Run specific evals by name (comma-separated)
    --grader=TYPE      Run only graders of this type (deterministic|llm_rubric)
    --trials=N         Override trial count (overrides preset)
    --parallel=N       Run trials concurrently
    --agent=claude                Override agent (default: claude)
    --output=DIR       Output directory for reports and temp files
                       Default: $TMPDIR/pathgrade
    --validate         Verify graders using reference solutions
    --ci               CI mode: exit non-zero if below threshold
    --threshold=0.8    Pass rate threshold for CI mode
    --preview          Open CLI results after running

  Examples:
    pathgrade init                # scaffold eval.yaml
    pathgrade init --force        # overwrite existing eval.yaml
    pathgrade                     # run all evals
    pathgrade --smoke             # quick 5-trial smoke test
    pathgrade --eval=fix-linting  # run a specific eval
    pathgrade --eval=foo,bar      # run multiple evals
    pathgrade --regression --ci   # CI regression with 30 trials
    pathgrade preview browser     # open web UI
`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
