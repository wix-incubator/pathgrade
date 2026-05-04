import type { JudgeScorer, ScorerContext } from './types.js';

export function buildJudgePrompt(
    scorer: JudgeScorer,
    ctx: ScorerContext,
    input?: Record<string, unknown>,
): string {
    const sections: string[] = [];
    sections.push(`## Session Transcript\n${ctx.transcript}`);

    if (scorer.includeToolEvents && ctx.toolEvents.length > 0) {
        sections.push(`## Tool Events\n${formatToolEvents(ctx)}`);
    }

    if (input) {
        for (const [key, value] of Object.entries(input)) {
            const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            sections.push(`## ${key}\n${body}`);
        }
    }

    return `You are an evaluation judge. Score the following agent session on a scale from 0.0 to 1.0 based on the rubric below.

${sections.join('\n\n')}

## Rubric
${scorer.rubric}

Respond with ONLY a JSON object: {"score": <number>, "details": "<brief explanation>"}`;
}

function formatToolEvents(ctx: ScorerContext): string {
    return ctx.toolEvents
        .map((event) => {
            const turn = event.turnNumber ? `turn ${event.turnNumber}` : 'instruction';
            return `- ${turn}: ${event.action} via ${event.providerToolName} (${event.provider})`;
        })
        .join('\n');
}

export function buildBatchedJudgePrompt(
    judges: JudgeScorer[],
    ctx: ScorerContext,
    inputs: Array<Record<string, unknown> | undefined>,
): string {
    const sections: string[] = [];
    sections.push(`## Session Transcript\n${ctx.transcript}`);

    if (judges.some((j) => j.includeToolEvents) && ctx.toolEvents.length > 0) {
        sections.push(`## Tool Events\n${formatToolEvents(ctx)}`);
    }

    const rubrics = judges.map((j, i) => {
        const parts = [`### Rubric ${i + 1}: "${j.name}"\n${j.rubric}`];
        const input = inputs[i];
        if (input) {
            for (const [key, value] of Object.entries(input)) {
                const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                parts.push(`#### ${key}\n${body}`);
            }
        }
        return parts.join('\n\n');
    }).join('\n\n');

    return `You are an evaluation judge. Score the following agent session on each rubric below, from 0.0 to 1.0.

${sections.join('\n\n')}

${rubrics}

Respond with ONLY a JSON array, one entry per rubric in order:
[{"scorer_name": "<name>", "score": <number>, "details": "<brief explanation>"}, ...]`;
}

export function buildToolUseJudgePrompt(
    scorer: JudgeScorer,
    ctx: ScorerContext,
): { system: string; user: string } {
    const system = [
        'You are an evaluation judge with access to workspace-reading tools.',
        'Use the tools to gather the evidence you need before scoring.',
        'When you have enough evidence, reply with a final score as a fenced JSON block:',
        '```json',
        '{"score": <number 0..1>, "details": "<one-paragraph rationale citing evidence>"}',
        '```',
        'Do not include any other text after the JSON block.',
    ].join('\n');

    const parts: string[] = [];
    parts.push('## Session Transcript');
    parts.push(ctx.transcript);
    if (scorer.includeToolEvents && ctx.toolEvents.length > 0) {
        parts.push('## Tool Events');
        parts.push(formatToolEvents(ctx));
    }
    parts.push('## Rubric');
    parts.push(scorer.rubric);

    return { system, user: parts.join('\n\n') };
}
