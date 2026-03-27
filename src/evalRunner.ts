import * as fs from 'fs-extra';
import * as path from 'path';
import { shutdown } from './utils/shutdown';
import {
    AgentCommandRunner,
    BaseAgent,
    CommandExecutionOptions,
    EnvironmentHandle,
    EnvironmentProvider,
    EvalReport,
    GraderResult,
    LogEntry,
    TrialResult,
    createAgentSession,
} from './types';
import { ResolvedConversation, ResolvedGrader } from './core/config.types';
import { runConversationTrial } from './conversationRunner';
import { getGrader } from './graders';
import { fmt, Spinner } from './utils/cli';
import { withAbortTimeout } from './utils/timeout';


function calculatePassAtK(n: number, c: number, k: number): number {
    if (n - c < k) return 1.0;
    let result = 1.0;
    for (let i = 0; i < k; i++) {
        result *= (n - c - i) / (n - i);
    }
    return 1.0 - result;
}

function calculatePassPowK(n: number, c: number, k: number): number {
    const p = c / n;
    return Math.pow(p, k);
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface EvalRunOptions {
    instruction?: string;
    conversation?: ResolvedConversation;
    graders: ResolvedGrader[];
    timeoutSec: number;
    graderModel?: string;
    graderTimeoutSec?: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    /** Set by the CLI entry point based on agent type + CLI availability. */
    authMode?: 'host' | 'isolated';
}

export class EvalRunner {
    private provider: EnvironmentProvider;
    private logDir?: string;

    constructor(provider: EnvironmentProvider, logDir?: string) {
        this.provider = provider;
        this.logDir = logDir;
    }

    private timestamp(): string {
        return new Date().toISOString();
    }

    async runEval(
        agentFactory: () => BaseAgent,
        taskPath: string,
        skillsPaths: string[],
        opts: EvalRunOptions,
        numTrials: number = 1,
        env?: Record<string, string>,
        parallel: number = 1
    ): Promise<EvalReport> {
        if (!opts.instruction && !opts.conversation) {
            throw new Error('EvalRunOptions must include instruction or conversation');
        }

        const taskName = path.basename(taskPath);

        if (this.provider.prepare) {
            const buildSpinner = new Spinner('build', 'building image');
            try {
                const imageId = await this.provider.prepare(taskPath, skillsPaths, opts, env);
                buildSpinner.stop(`${fmt.dim('image ready')}  ${fmt.dim(typeof imageId === 'string' ? imageId : '')}`);
            } catch (error) {
                buildSpinner.stop(`${fmt.fail('build failed')}`);
                throw error;
            }
        }

        let trials: TrialResult[];

        try {
            if (parallel > 1 && numTrials > 1) {
                trials = await this.runTrialsParallel(agentFactory, taskPath, skillsPaths, opts, numTrials, parallel, env);
            } else {
                trials = [];
                for (let i = 0; i < numTrials; i++) {
                    trials.push(await this.runSingleTrial(agentFactory, taskPath, skillsPaths, opts, i, numTrials, env));
                }
            }
        } finally {
            if (this.provider.teardown) {
                await this.provider.teardown();
            }
        }

        const totalReward = trials.reduce((sum, trial) => sum + trial.reward, 0);
        const successes = trials.filter((trial) => trial.reward >= 0.5).length;

        const report: EvalReport = {
            task: taskName,
            pass_rate: totalReward / numTrials,
            pass_at_k: calculatePassAtK(numTrials, successes, numTrials),
            pass_pow_k: calculatePassPowK(numTrials, successes, numTrials),
            trials,
            skills_used: skillsPaths.map((skillPath) => path.basename(skillPath)),
        };

        if (this.logDir) {
            const sanitized = this.sanitize(report, env);
            await this.saveReport(sanitized);
        }

        return report;
    }

    private async runTrialsParallel(
        agentFactory: () => BaseAgent,
        taskPath: string,
        skillsPaths: string[],
        opts: EvalRunOptions,
        numTrials: number,
        parallel: number,
        env?: Record<string, string>
    ): Promise<TrialResult[]> {
        const results: TrialResult[] = new Array(numTrials);
        const queue = Array.from({ length: numTrials }, (_, index) => index);

        const workers = Array.from({ length: Math.min(parallel, numTrials) }, async () => {
            while (queue.length > 0) {
                const index = queue.shift()!;
                results[index] = await this.runSingleTrial(agentFactory, taskPath, skillsPaths, opts, index, numTrials, env);
            }
        });

        await Promise.all(workers);
        return results;
    }

    private async runSingleTrial(
        agentFactory: () => BaseAgent,
        taskPath: string,
        skillsPaths: string[],
        opts: EvalRunOptions,
        index: number,
        total: number,
        env?: Record<string, string>
    ): Promise<TrialResult> {
        const sessionLog: LogEntry[] = [];
        let commandCount = 0;
        const startTime = Date.now();
        const agent = agentFactory();

        const spinner = new Spinner(`${index + 1}/${total}`, 'setting up environment');
        const runtime = await this.provider.setup(taskPath, skillsPaths, opts, env);
        const cleanupId = shutdown.register(async () => {
            try { await this.provider.cleanup(runtime); } catch {}
        });

        try {
            let inputText = '';
            let conversationData: TrialResult['conversation'];
            let personaInputTokens: number | undefined;
            let personaOutputTokens: number | undefined;

            if (opts.conversation) {
                spinner.update('running conversation');
                const conversationResult = await runConversationTrial({
                    agent,
                    conversation: opts.conversation,
                    env,
                    graderModel: opts.graderModel,
                    provider: this.provider,
                    runtime,
                    taskPath,
                    timeoutSec: opts.timeoutSec,
                    timestamp: () => this.timestamp(),
                });
                sessionLog.push(...conversationResult.sessionLog);
                commandCount = conversationResult.commandCount;
                conversationData = conversationResult.conversation;
                inputText = conversationResult.inputText;
                personaInputTokens = conversationResult.personaInputTokens;
                personaOutputTokens = conversationResult.personaOutputTokens;
            } else {
                if (!opts.instruction) {
                    throw new Error('EvalRunOptions must include instruction or conversation');
                }

                const instruction = opts.instruction;
                inputText = instruction;
                sessionLog.push({
                    type: 'agent_start',
                    timestamp: this.timestamp(),
                    instruction,
                });

                const agentTimeoutMs = opts.timeoutSec * 1000;
                spinner.update('running agent');
                const turnResult = await withAbortTimeout(
                    async (signal) => {
                        const loggedRunCommand: AgentCommandRunner = async (cmd: string, options?: CommandExecutionOptions) => {
                            const result = await this.provider.runCommand(runtime, cmd, env, {
                                ...options,
                                signal: options?.signal ?? signal,
                            });
                            commandCount++;
                            sessionLog.push({
                                type: 'command',
                                timestamp: this.timestamp(),
                                command: cmd,
                                stdout: result.stdout,
                                stderr: result.stderr,
                                exitCode: result.exitCode,
                            });
                            return result;
                        };

                        const session = await createAgentSession(agent, runtime, loggedRunCommand);
                        return await session.start({ message: instruction });
                    },
                    agentTimeoutMs,
                    `Agent (limit: ${opts.timeoutSec}s)`
                );

                sessionLog.push({
                    type: 'agent_result',
                    timestamp: this.timestamp(),
                    output: turnResult.rawOutput,
                    assistant_message: turnResult.assistantMessage,
                });
            }

            const { graderResults, reward } = await this.runGraders(runtime, taskPath, opts, sessionLog, spinner, env);

            sessionLog.push({
                type: 'reward',
                timestamp: this.timestamp(),
                value: reward,
            });

            const duration_ms = Date.now() - startTime;
            const input_tokens = conversationData
                ? conversationData.turns.reduce((sum, turn) => sum + estimateTokens(turn.user_message), 0)
                : estimateTokens(inputText);
            const output_tokens = conversationData
                ? conversationData.turns.reduce((sum, turn) => sum + estimateTokens(turn.assistant_message), 0)
                : sessionLog
                    .filter((entry) => entry.type === 'agent_result' || entry.type === 'command')
                    .reduce((sum, entry) => sum + estimateTokens((entry.output || '') + (entry.stdout || '') + (entry.stderr || '')), 0);

            const status = reward >= 0.5 ? fmt.pass('PASS') : fmt.fail('FAIL');
            spinner.stop(`${status}  ${fmt.bold(reward.toFixed(2))}  ${fmt.dim((duration_ms / 1000).toFixed(1) + 's')}  ${fmt.dim(commandCount + ' cmds')}`);

            return {
                trial_id: index + 1,
                reward,
                grader_results: graderResults,
                duration_ms,
                n_commands: commandCount,
                input_tokens,
                output_tokens,
                persona_input_tokens: personaInputTokens,
                persona_output_tokens: personaOutputTokens,
                session_log: sessionLog,
                conversation: conversationData,
            };
        } catch (error: unknown) {
            const duration_ms = Date.now() - startTime;
            const errorMsg = (error as Error)?.message || String(error);
            spinner.stop(`${fmt.fail('FAIL')}  ${errorMsg.substring(0, 50)}  ${fmt.dim((duration_ms / 1000).toFixed(1) + 's')}`);

            let diagnostics = '';
            if (this.provider.diagnose) {
                try {
                    diagnostics = await this.provider.diagnose(runtime);
                    console.log(diagnostics);
                } catch (diagnosticsError) {
                    diagnostics = `(diagnostics failed: ${diagnosticsError})`;
                }
            }

            sessionLog.push({
                type: 'reward',
                timestamp: this.timestamp(),
                value: 0,
                output: diagnostics ? `${errorMsg}\n\n${diagnostics}` : errorMsg,
            });

            return {
                trial_id: index + 1,
                reward: 0,
                grader_results: [],
                duration_ms,
                n_commands: commandCount,
                input_tokens: 0,
                output_tokens: 0,
                session_log: sessionLog,
            };
        } finally {
            shutdown.unregister(cleanupId);
            await this.provider.cleanup(runtime);
        }
    }

    private async runGraders(
        runtime: EnvironmentHandle,
        taskPath: string,
        opts: EvalRunOptions,
        sessionLog: LogEntry[],
        spinner: Spinner,
        env?: Record<string, string>
    ): Promise<{ graderResults: GraderResult[]; reward: number }> {
        const graderResults: GraderResult[] = [];

        for (let gIdx = 0; gIdx < opts.graders.length; gIdx++) {
            const graderDef = opts.graders[gIdx];
            const grader = getGrader(graderDef.type);
            spinner.update(`grading (${graderDef.type}${opts.graders.length > 1 ? ` ${gIdx + 1}/${opts.graders.length}` : ''})`);

            const detIndex = opts.graders.slice(0, gIdx).filter((graderEntry) => graderEntry.type === 'deterministic').length;
            const llmIndex = opts.graders.slice(0, gIdx).filter((graderEntry) => graderEntry.type === 'llm_rubric').length;

            const graderConfig = {
                type: graderDef.type,
                command: graderDef.type === 'deterministic'
                    ? `bash .pathgrade/tests/${detIndex === 0 ? 'test.sh' : `test_${detIndex}.sh`}`
                    : undefined,
                rubric: graderDef.type === 'llm_rubric'
                    ? `.pathgrade/prompts/${llmIndex === 0 ? 'quality.md' : `quality_${llmIndex}.md`}`
                    : undefined,
                model: graderDef.model || opts.graderModel,
                weight: graderDef.weight,
            };

            const graderTimeoutMs = (opts.graderTimeoutSec ?? 120) * 1000;
            const result = await withAbortTimeout(
                async (signal) => grader.grade(runtime, this.provider, graderConfig, taskPath, sessionLog, env, signal),
                graderTimeoutMs,
                `Grader ${graderDef.type} (limit: ${opts.graderTimeoutSec ?? 120}s)`
            );
            graderResults.push(result);

            sessionLog.push({
                type: 'grader',
                timestamp: this.timestamp(),
                grader_result: result,
            });
        }

        const totalWeight = graderResults.reduce((sum, result) => sum + result.weight, 0);
        const reward = totalWeight > 0
            ? graderResults.reduce((sum, result) => sum + result.score * result.weight, 0) / totalWeight
            : 0;

        return { graderResults, reward };
    }

    private sanitize(report: EvalReport, env?: Record<string, string>): EvalReport {
        if (!env) return report;

        const sanitized = JSON.parse(JSON.stringify(report));
        const secrets = Object.values(env);

        const redact = (text: string) => {
            let result = text;
            for (const secret of secrets) {
                if (secret && secret.length > 5) {
                    result = result.split(secret).join('[REDACTED]');
                }
            }
            return result;
        };

        for (const trial of sanitized.trials) {
            for (const entry of trial.session_log) {
                if (entry.instruction) entry.instruction = redact(entry.instruction);
                if (entry.command) entry.command = redact(entry.command);
                if (entry.stdout) entry.stdout = redact(entry.stdout);
                if (entry.stderr) entry.stderr = redact(entry.stderr);
                if (entry.output) entry.output = redact(entry.output);
                if (entry.assistant_message) entry.assistant_message = redact(entry.assistant_message);
                if (entry.grader_result?.details) entry.grader_result.details = redact(entry.grader_result.details);
            }
            for (const graderResult of trial.grader_results) {
                if (graderResult.details) graderResult.details = redact(graderResult.details);
            }
            if (trial.conversation?.turns) {
                for (const turn of trial.conversation.turns) {
                    turn.user_message = redact(turn.user_message);
                    turn.assistant_message = redact(turn.assistant_message);
                    turn.raw_agent_output = redact(turn.raw_agent_output);
                    if (turn.step_grader_results) {
                        for (const sg of turn.step_grader_results) {
                            if (sg.details) sg.details = redact(sg.details);
                        }
                    }
                }
            }
        }

        return sanitized;
    }

    private async saveReport(report: EvalReport): Promise<void> {
        if (!this.logDir) return;

        await fs.ensureDir(this.logDir);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${report.task}_${timestamp}.json`;
        const filePath = path.join(this.logDir, fileName);

        const tmpPath = filePath + '.tmp';

        await fs.writeJSON(tmpPath, report, { spaces: 2 });
        await fs.move(tmpPath, filePath, { overwrite: true });
    }
}
