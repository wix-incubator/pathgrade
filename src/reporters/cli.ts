import * as fs from 'fs-extra';
import * as path from 'path';
import { fmt, header } from '../utils/cli';
import { EvalReport, TrialResult, GraderResult, ConversationTurn } from '../types';

// ─── Main ──────────────────────────────────────────────────
export async function runCliPreview(resultsDir: string) {
    const resolved = path.resolve(resultsDir);
    const files = (await fs.readdir(resolved))
        .filter(f => f.endsWith('.json'))
        .reverse();

    if (!files.length) {
        console.log(`\n  ${fmt.dim('No reports found in')} ${resolved}\n`);
        return;
    }

    console.log(`\n${fmt.bold('pathgrade preview')}  ${fmt.dim(`${files.length} reports from ${resolved}`)}\n`);

    for (const file of files) {
        let report: EvalReport;
        try { report = await fs.readJSON(path.join(resolved, file)) as EvalReport; }
        catch { continue; }

        const passRate = report.pass_rate ?? 0;
        const isPass = passRate >= 0.5;
        const trials = report.trials || [];
        const avgDur = trials.reduce((s: number, t: TrialResult) => s + (t.duration_ms || 0), 0) / (trials.length || 1);
        const totalTokens = trials.reduce((s: number, t: TrialResult) => s + (t.input_tokens || 0) + (t.output_tokens || 0), 0);

        // ── Report header
        const status = isPass ? fmt.pass('PASS') : fmt.fail('FAIL');
        header(`${status}  ${report.task}`);

        // Timestamp from filename
        const ts = file.match(/\d{4}-\d{2}-\d{2}T[\d-]+/)?.[0]?.replace(/-(\d{2})-(\d{2})-/g, ':$1:$2:') || '';
        if (ts) console.log(`    ${fmt.dim(ts)}`);
        console.log();

        // ── Summary metrics
        const metrics = [
            ['Pass Rate', `${(passRate * 100).toFixed(1)}%`],
            ['pass@k', report.pass_at_k != null ? `${(report.pass_at_k * 100).toFixed(1)}%` : '—'],
            ['pass^k', report.pass_pow_k != null ? `${(report.pass_pow_k * 100).toFixed(1)}%` : '—'],
            ['Avg Duration', `${(avgDur / 1000).toFixed(1)}s`],
            ['Total Tokens', `~${totalTokens}`],
            ['Skills', report.skills_used?.join(', ') || 'none'],
        ];

        for (const [label, value] of metrics) {
            console.log(`    ${fmt.dim(label.padEnd(14))} ${fmt.bold(value)}`);
        }
        console.log();

        // ── Trials
        for (const trial of trials) {
            const tp = trial.reward >= 0.5;
            const trialStatus = tp ? fmt.pass('PASS') : fmt.fail('FAIL');
            const reward = fmt.bold(trial.reward.toFixed(2));
            const dur = `${((trial.duration_ms || 0) / 1000).toFixed(1)}s`;
            const cmds = `${trial.n_commands || 0} cmds`;
            const graders = (trial.grader_results || []).map((g: GraderResult) => {
                const scoreStr = g.score.toFixed(1);
                const colored = g.score >= 0.5 ? fmt.green(scoreStr) : fmt.red(scoreStr);
                return `${fmt.dim(g.grader_type)} ${colored}`;
            }).join('  ');

            const convSuffix = trial.conversation
                ? `  ${fmt.dim(`${trial.conversation.total_turns} turns`)}  ${fmt.dim(trial.conversation.completion_reason)}`
                : '';

            console.log(`    ${fmt.dim(`${trial.trial_id}`.padEnd(4))} ${trialStatus}  ${reward}  ${fmt.dim(dur.padEnd(7))} ${fmt.dim(cmds.padEnd(7))} ${graders}${convSuffix}`);
        }
        console.log();

        // ── LLM grader details
        const hasLlm = trials.some((t: TrialResult) => t.grader_results?.some((g: GraderResult) => g.grader_type === 'llm_rubric'));
        if (hasLlm) {
            for (const trial of trials) {
                const llmGraders = (trial.grader_results || []).filter((g: GraderResult) => g.grader_type === 'llm_rubric');
                for (const g of llmGraders) {
                    const scoreStr = g.score >= 0.5 ? fmt.green(g.score.toFixed(2)) : fmt.red(g.score.toFixed(2));
                    console.log(`    ${fmt.dim(`trial ${trial.trial_id}`)} ${scoreStr} ${fmt.dim(g.details.substring(0, 100))}`);
                }
            }
            console.log();
        }

        // ── Step grader details (conversation trials)
        const hasStepGraders = trials.some((t: TrialResult) =>
            t.conversation?.turns?.some((turn: ConversationTurn) => (turn.step_grader_results?.length ?? 0) > 0));
        if (hasStepGraders) {
            console.log(`    ${fmt.bold('Step Graders')}`);
            for (const trial of trials) {
                if (!trial.conversation?.turns) continue;
                for (const turn of trial.conversation.turns) {
                    if (!turn.step_grader_results?.length) continue;
                    for (const g of turn.step_grader_results) {
                        const scoreStr = g.score >= 0.5 ? fmt.green(g.score.toFixed(2)) : fmt.red(g.score.toFixed(2));
                        console.log(`    ${fmt.dim(`trial ${trial.trial_id} turn ${turn.turn_number}`)} ${scoreStr} ${fmt.dim(g.grader_type)}  ${fmt.dim(g.details.substring(0, 80))}`);
                    }
                }
            }
            console.log();
        }

        console.log(`    ${fmt.dim(file)}`);
        console.log();
    }
}
