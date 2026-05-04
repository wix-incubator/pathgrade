import * as path from 'path';
import { fmt, header } from '../utils/cli.js';
import { TrialResult, ScorerResult, ConversationTurn } from '../types.js';
import type { PreviewOptions } from '../commands/preview.js';
import { loadReports } from './loader.js';

// ─── Main ──────────────────────────────────────────────────
export async function runCliPreview(resultsDir: string, opts?: PreviewOptions) {
    const resolved = path.resolve(resultsDir);
    let entries = await loadReports(resolved);

    if (opts?.filter) {
        const pattern = opts.filter.toLowerCase();
        entries = entries.filter(e => e.task?.toLowerCase().includes(pattern));
    }

    if (opts?.last && opts.last > 0) {
        entries = entries.slice(0, opts.last);
    }

    if (!entries.length) {
        console.log(`\n  ${fmt.dim('No reports found in')} ${resolved}\n`);
        return;
    }

    console.log(`\n${fmt.bold('pathgrade preview')}  ${fmt.dim(`${entries.length} reports from ${resolved}`)}\n`);

    for (const { file, ...report } of entries) {

        const passRate = report.pass_rate ?? 0;
        const isPass = passRate >= 0.5;
        const trials = report.trials || [];
        const avgDur = trials.reduce((s: number, t: TrialResult) => s + (t.duration_ms || 0), 0) / (trials.length || 1);
        const totalTokens = trials.reduce((s: number, t: TrialResult) => s + (t.input_tokens || 0) + (t.output_tokens || 0) + (t.conversation_input_tokens || 0) + (t.conversation_output_tokens || 0), 0);

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
            const scorers = (trial.scorer_results || []).map((g: ScorerResult) => {
                const scoreStr = g.score.toFixed(1);
                const colored = g.score >= 0.5 ? fmt.green(scoreStr) : fmt.red(scoreStr);
                const statusLabel = formatScorerStatus(g.status);
                return `${fmt.dim(g.scorer_type)}${statusLabel ? ` ${statusLabel}` : ''} ${colored}`;
            }).join('  ');

            const toolEvents = (trial.session_log || []).filter((entry: any) => entry.type === 'tool_event');
            const toolSuffix = toolEvents.length ? `  ${fmt.dim(toolEvents.length + ' tool events')}` : '';

            const judgeToolCalls = (trial.session_log || []).filter((entry: any) => entry.type === 'judge_tool_call');
            const judgeToolNames = judgeToolCalls
                .map((e: any) => e.judge_tool_call?.name)
                .filter(Boolean);
            const uniqueJudgeTools = Array.from(new Set<string>(judgeToolNames));
            const judgeToolSuffix = judgeToolCalls.length
                ? `  ${fmt.dim(`${judgeToolCalls.length} judge tool calls (${uniqueJudgeTools.join(', ')})`)}`
                : '';

            const convSuffix = trial.conversation
                ? `  ${fmt.dim(`${trial.conversation.total_turns} turns`)}  ${fmt.dim(trial.conversation.completion_reason)}`
                : '';

            const trialLabel = trial.name || `${trial.trial_id}`;
            console.log(`    ${fmt.dim(trialLabel.padEnd(4))} ${trialStatus}  ${reward}  ${fmt.dim(dur.padEnd(7))} ${fmt.dim(cmds.padEnd(7))} ${scorers}${convSuffix}${toolSuffix}${judgeToolSuffix}`);
        }
        console.log();

        const nonOkScorers = trials.flatMap((trial: TrialResult) =>
            (trial.scorer_results || [])
                .filter((g: ScorerResult) => g.status && g.status !== 'ok')
                .map((g: ScorerResult) => ({ trial, scorer: g })),
        );
        if (nonOkScorers.length > 0) {
            console.log(`    ${fmt.bold('Scorer Statuses')}`);
            for (const entry of nonOkScorers) {
                console.log(`    ${fmt.dim(`trial ${entry.trial.trial_id}`)} ${formatScorerStatus(entry.scorer.status)} ${fmt.dim(entry.scorer.scorer_type)} ${fmt.dim(entry.scorer.details.substring(0, 100))}`);
            }
            console.log();
        }

        // ── LLM scorer details
        const hasLlm = trials.some((t: TrialResult) => t.scorer_results?.some((g: ScorerResult) => g.scorer_type === 'llm_rubric'));
        if (hasLlm) {
            for (const trial of trials) {
                const llmScorers = (trial.scorer_results || []).filter((g: ScorerResult) => g.scorer_type === 'llm_rubric');
                for (const g of llmScorers) {
                    const scoreStr = g.score >= 0.5 ? fmt.green(g.score.toFixed(2)) : fmt.red(g.score.toFixed(2));
                    console.log(`    ${fmt.dim(`trial ${trial.trial_id}`)} ${scoreStr} ${fmt.dim(g.details.substring(0, 100))}`);
                }
            }
            console.log();
        }

        // ── Step scorer details (conversation trials)
        const hasStepScorers = trials.some((t: TrialResult) =>
            t.conversation?.turns?.some((turn: ConversationTurn) => (turn.step_scorer_results?.length ?? 0) > 0));
        if (hasStepScorers) {
            console.log(`    ${fmt.bold('Step Scorers')}`);
            for (const trial of trials) {
                if (!trial.conversation?.turns) continue;
                for (const turn of trial.conversation.turns) {
                    if (!turn.step_scorer_results?.length) continue;
                    for (const g of turn.step_scorer_results) {
                        const scoreStr = g.score >= 0.5 ? fmt.green(g.score.toFixed(2)) : fmt.red(g.score.toFixed(2));
                        const statusLabel = formatScorerStatus(g.status);
                        console.log(`    ${fmt.dim(`trial ${trial.trial_id} turn ${turn.turn_number}`)} ${scoreStr} ${fmt.dim(g.scorer_type)}${statusLabel ? ` ${statusLabel}` : ''}  ${fmt.dim(g.details.substring(0, 80))}`);
                    }
                }
            }
            console.log();
        }

        console.log(`    ${fmt.dim(file)}`);
        console.log();
    }
}

function formatScorerStatus(status: ScorerResult['status']): string {
    switch (status) {
        case 'error':
            return '[ERROR]';
        case 'skipped':
            return '[SKIPPED]';
        default:
            return '';
    }
}
