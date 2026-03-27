/**
 * `pathgrade` (run) command.
 *
 * Reads eval.ts, resolves tasks, and executes evals.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { loadEvalConfig, resolveTask } from '../core/config';
import { detectSkills } from '../core/skills';
import { LocalProvider } from '../providers/local';
import { EvalRunner, EvalRunOptions } from '../evalRunner';
import { createAgent } from '../agents/registry';
import { AgentCommandRunner, BaseAgent, EvalReport } from '../types';
import { ResolvedTask, AgentName } from '../core/config.types';
import { parseEnvFile } from '../utils/env';
import {
    TESTS_DIR,
    PROMPTS_DIR,
    STEP_TESTS_DIR,
    STEP_PROMPTS_DIR,
    deterministicScriptName,
    llmRubricName,
} from '../graders/paths';
import { fmt, header, kv, trialRow, resultsSummary, validationResult } from '../utils/cli';
import { isClaudeCliAvailable } from '../utils/cli-llm';

interface RunOptions {
    eval?: string;       // run specific eval(s) by name (comma-separated)
    trials?: number;     // override trial count
    parallel?: number;
    validate?: boolean;
    ci?: boolean;
    threshold?: number;
    preset?: 'smoke' | 'reliable' | 'regression';
    agent?: AgentName;   // override agent (gemini|claude|codex)
    output?: string;     // output directory for reports and temp files
    grader?: string;     // filter graders by type (deterministic|llm_rubric)
}

async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
    if (await fs.pathExists(filePath)) {
        return parseEnvFile(await fs.readFile(filePath, 'utf-8'));
    }
    return {};
}

export async function runEvals(dir: string, opts: RunOptions) {
    console.log(`\n${fmt.bold('pathgrade')}\n`);

    // Load eval config
    const config = await loadEvalConfig(dir);

    // Load environment variables
    const rootEnv = await loadEnvFile(path.join(dir, '.env'));
    const env: Record<string, string> = { ...rootEnv };
    if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

    if (Object.keys(rootEnv).length > 0) {
        kv('env', Object.keys(rootEnv).join(', '));
    }

    // Detect skills
    let skillsPaths: string[] = [];
    if (config.skillPath) {
        let skillDir = path.resolve(dir, config.skillPath);
        const stat = await fs.stat(skillDir).catch(() => null);
        if (stat?.isFile()) {
            skillDir = path.dirname(skillDir);
        }
        if (stat && await fs.pathExists(skillDir)) {
            skillsPaths = [skillDir];
            kv('skill', path.relative(dir, skillDir) || '.');
        } else {
            console.error(`  ${fmt.red('warning')}  skill path not found: ${config.skillPath}`);
        }
    } else {
        const skills = await detectSkills(dir);
        skillsPaths = skills.map(s => s.path);
        if (skills.length > 0) {
            kv('skills', skills.map(s => s.name).join(', '));
        }
    }

    // Filter evals
    let tasksToRun = config.tasks;
    if (opts.eval) {
        const evalNames = opts.eval.split(',').map(s => s.trim());
        tasksToRun = config.tasks.filter(t => evalNames.includes(t.name));
        if (tasksToRun.length === 0) {
            console.error(`  ${fmt.red('error')}  eval "${opts.eval}" not found`);
            console.log(`  ${fmt.dim('available:')} ${config.tasks.map(t => t.name).join(', ')}`);
            throw new Error(`Eval "${opts.eval}" not found`);
        }
    }

    // Output directory
    const outputBase = opts.output || path.join(os.tmpdir(), 'pathgrade');
    const skillName = path.basename(dir);
    const outputDir = path.join(outputBase, skillName);
    const resultsDir = path.join(outputDir, 'results');
    await fs.ensureDir(resultsDir);
    kv('output', outputDir);

    // Track CI results
    const reports: EvalReport[] = [];
    let allPassed = true;

    // Run each task
    for (const taskDef of tasksToRun) {
        const resolved = await resolveTask(taskDef, config.defaults, dir);
        const trials = opts.trials ?? resolved.trials;
        const parallel = opts.parallel ?? 1;

        // Create a local task bundle for this run
        const tmpTaskDir = path.join(outputDir, 'tmp', resolved.name);
        await prepareTempTaskDir(resolved, dir, tmpTaskDir);

        try {
            // Pick agent: CLI flag > task-level override > default
            // Currently only Claude is supported as the solver agent.
            const agentName: AgentName = opts.agent || resolved.agent || 'claude';

            // Host-auth passthrough for CLI-authenticated agents
            const cliAgents = ['claude', 'codex'];
            const useHostAuth = cliAgents.includes(agentName) && await isClaudeCliAvailable();

            // Build eval options — pass resolved content directly
            const filteredGraders = opts.grader
                ? resolved.graders.filter(g => g.type === opts.grader)
                : resolved.graders;
            let evalOpts: EvalRunOptions;
            if (resolved.type === 'conversation') {
                evalOpts = {
                    instruction: undefined,
                    conversation: resolved.conversation,
                    graders: filteredGraders,
                    timeoutSec: resolved.conversation.completion.timeout ?? resolved.timeout,
                    graderModel: resolved.grader_model,
                    environment: resolved.environment,
                    authMode: useHostAuth ? 'host' : undefined,
                };
            } else {
                evalOpts = {
                    instruction: resolved.instruction,
                    graders: filteredGraders,
                    timeoutSec: resolved.timeout,
                    graderModel: resolved.grader_model,
                    environment: resolved.environment,
                    authMode: useHostAuth ? 'host' : undefined,
                };
            }

            const provider = new LocalProvider();

            const runner = new EvalRunner(provider, resultsDir);

            if (opts.validate) {
                // Validation mode
                if (!resolved.solution) {
                    console.error(`  ${fmt.red('error')}  task "${resolved.name}" has no solution defined`);
                    continue;
                }
                if (resolved.type === 'conversation') {
                    console.error(`  ${fmt.red('error')}  validation mode does not support conversation tasks yet`);
                    allPassed = false;
                    continue;
                }

                header(`validate: ${resolved.name}`);

                const solveAgent = {
                    async run(_instruction: string, _workspace: string, runCommand: AgentCommandRunner) {
                        const result = await runCommand(`bash ${path.basename(resolved.solution!)}`);
                        return result.stdout;
                    }
                } as BaseAgent;

                const report = await runner.runEval(() => solveAgent, tmpTaskDir, skillsPaths, evalOpts, 1, env);
                const passed = report.trials[0].reward >= 0.5;

                validationResult(passed, report.trials[0].reward, report.trials[0].grader_results.map(gr => ({
                    type: gr.grader_type,
                    score: gr.score,
                    details: gr.details
                })));

                if (!passed) allPassed = false;
            } else {
                // Normal eval mode
                header(resolved.name);
                console.log(`    ${fmt.dim('agent')} ${agentName}  ${fmt.dim('runtime')} local  ${fmt.dim('trials')} ${trials}${parallel > 1 ? `  ${fmt.dim('parallel')} ${parallel}` : ''}`);
                console.log();

                try {
                    const report = await runner.runEval(() => createAgent(agentName), tmpTaskDir, skillsPaths, evalOpts, trials, env, parallel);
                    reports.push(report);

                    // LLM grader reasoning (condensed)
                    for (const trial of report.trials) {
                        for (const g of trial.grader_results.filter(g => g.grader_type === 'llm_rubric')) {
                            console.log(`    ${fmt.dim(`trial ${trial.trial_id} llm_rubric:`)} ${g.details.substring(0, 120)}`);
                        }
                    }

                    resultsSummary(report.pass_rate, report.pass_at_k, report.pass_pow_k, trials, opts.preset);

                    if (report.pass_rate < (opts.threshold ?? config.defaults.threshold)) {
                        allPassed = false;
                    }
                } catch (err) {
                    console.error(`\n  ${fmt.fail('error')}  evaluation failed: ${err}\n`);
                    allPassed = false;
                }
            }
        } finally {
            try { await fs.remove(tmpTaskDir); } catch { /* ignore cleanup errors */ }
        }
    }

    // CI mode: exit with appropriate code
    if (opts.ci) {
        const threshold = opts.threshold ?? config.defaults.threshold;
        if (!allPassed) {
            console.error(`\n  ${fmt.fail('CI FAILED')}  below threshold ${(threshold * 100).toFixed(0)}%\n`);
            throw new Error('CI check failed');
        }
        console.log(`\n  ${fmt.pass('CI PASSED')}  above threshold ${(threshold * 100).toFixed(0)}%\n`);
    }
}

/**
 * Returns true if childPath is contained within parentPath (i.e. does not escape it).
 */
function isContainedIn(childPath: string, parentPath: string): boolean {
    const resolved = path.resolve(childPath);
    const parent = path.resolve(parentPath) + path.sep;
    return resolved.startsWith(parent) || resolved === path.resolve(parentPath);
}

/**
 * Create a temp task directory for runtime execution.
 * Contains shared workspace files and grader scripts for the local runtime.
 * No longer writes task.toml or instruction.md — those are passed directly.
 */
export async function prepareTempTaskDir(
    resolved: ResolvedTask,
    baseDir: string,
    tmpDir: string
) {
    await fs.ensureDir(tmpDir);

    // Stage grader assets in a hidden .pathgrade directory so the agent
    // doesn't see them when exploring the workspace during conversation evals.

    // Write each deterministic grader script
    await fs.ensureDir(path.join(tmpDir, TESTS_DIR));
    const detGraders = resolved.graders.filter(g => g.type === 'deterministic');
    for (let i = 0; i < detGraders.length; i++) {
        if (detGraders[i].run) {
            const script = `#!/bin/bash\n${detGraders[i].run!.trim()}\n`;
            await fs.writeFile(path.join(tmpDir, TESTS_DIR, deterministicScriptName(i)), script);
        }
    }

    // Copy referenced grader files/directories to workspace root (not .pathgrade)
    // because grader scripts reference them by relative path from the workspace.
    for (const g of resolved.graders) {
        if (g.type === 'deterministic' && g.run) {
            const pathMatches = g.run.match(/[\w./-]+\.\w{1,4}/g) || [];
            for (const ref of pathMatches) {
                const refDir = ref.split('/')[0];
                const srcDir = path.resolve(baseDir, refDir);
                const destDir = path.join(tmpDir, refDir);
                if (!isContainedIn(srcDir, baseDir)) continue;
                if (refDir !== ref && await fs.pathExists(srcDir) && !await fs.pathExists(destDir)) {
                    await fs.copy(srcDir, destDir);
                }
            }
        }
    }

    // Write each LLM rubric
    await fs.ensureDir(path.join(tmpDir, PROMPTS_DIR));
    const llmGraders = resolved.graders.filter(g => g.type === 'llm_rubric');
    for (let i = 0; i < llmGraders.length; i++) {
        if (llmGraders[i].rubric) {
            await fs.writeFile(path.join(tmpDir, PROMPTS_DIR, llmRubricName(i)), llmGraders[i].rubric!);
        }
    }

    // Write step grader assets into namespaced subdirectories
    const stepGraders = resolved.type === 'conversation' ? resolved.conversation.step_graders : undefined;
    if (stepGraders) {
        await fs.ensureDir(path.join(tmpDir, STEP_TESTS_DIR));
        await fs.ensureDir(path.join(tmpDir, STEP_PROMPTS_DIR));
        for (const sg of stepGraders) {
            for (let gIdx = 0; gIdx < sg.graders.length; gIdx++) {
                const g = sg.graders[gIdx];
                if (g.type === 'deterministic' && g.run) {
                    const script = `#!/bin/bash\n${g.run.trim()}\n`;
                    await fs.writeFile(
                        path.join(tmpDir, STEP_TESTS_DIR, `turn_${sg.after_turn}_${gIdx}.sh`),
                        script
                    );
                }
                if (g.type === 'llm_rubric' && g.rubric) {
                    await fs.writeFile(
                        path.join(tmpDir, STEP_PROMPTS_DIR, `turn_${sg.after_turn}_${gIdx}.md`),
                        g.rubric
                    );
                }
            }
        }
    }

    // Copy workspace files into the local task bundle.
    for (const w of resolved.workspace) {
        const srcPath = path.resolve(baseDir, w.src);
        if (!isContainedIn(srcPath, baseDir)) {
            console.warn(`  ${fmt.dim('warning')}  workspace src "${w.src}" escapes project directory, skipping`);
            continue;
        }
        const destName = w.dest || path.basename(w.src);
        const destInTmp = path.join(tmpDir, destName);
        if (await fs.pathExists(srcPath)) {
            await fs.copy(srcPath, destInTmp);
            if (w.chmod) {
                await fs.chmod(destInTmp, w.chmod);
            }
        }
    }
}
