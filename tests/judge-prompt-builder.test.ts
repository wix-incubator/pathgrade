import { describe, it, expect } from 'vitest';
import * as os from 'os';
import {
    buildJudgePrompt,
    buildBatchedJudgePrompt,
    buildToolUseJudgePrompt,
} from '../src/sdk/judge-prompt-builder.js';
import type { JudgeScorer, ScorerContext } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';

function makeCtx(overrides: Partial<ScorerContext> = {}): ScorerContext {
    return {
        workspace: os.tmpdir(),
        log: [],
        transcript: '[User]\nDo the thing\n\n[Agent]\nDone',
        toolEvents: [],
        runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        artifacts: {
            list: () => [],
            read: async () => '',
            latest: async () => ({ path: '', content: '' }),
        },
        ...overrides,
    };
}

const minimalJudge: JudgeScorer = {
    type: 'judge',
    name: 'quality',
    weight: 1,
    rubric: 'Rate the helpfulness 0.0–1.0.',
};

describe('buildJudgePrompt', () => {
    it('renders a minimal single-judge prompt with transcript + rubric and asks for details', () => {
        const prompt = buildJudgePrompt(minimalJudge, makeCtx());
        expect(prompt).toMatchInlineSnapshot(`
          "You are an evaluation judge. Score the following agent session on a scale from 0.0 to 1.0 based on the rubric below.

          ## Session Transcript
          [User]
          Do the thing

          [Agent]
          Done

          ## Rubric
          Rate the helpfulness 0.0–1.0.

          Respond with ONLY a JSON object: {"score": <number>, "details": "<brief explanation>"}"
        `);
    });

    it('includes a Tool Events section when includeToolEvents is on and events exist', () => {
        const scorer: JudgeScorer = { ...minimalJudge, includeToolEvents: true };
        const ctx = makeCtx({
            toolEvents: [
                { turnNumber: 2, action: 'read_file', providerToolName: 'Read', provider: 'claude', summary: '', confidence: 'high', rawSnippet: '' },
                { action: 'write_file', providerToolName: 'Write', provider: 'claude', summary: '', confidence: 'high', rawSnippet: '' },
            ],
        });
        const prompt = buildJudgePrompt(scorer, ctx);
        expect(prompt).toContain('## Tool Events');
        expect(prompt).toContain('- turn 2: read_file via Read (claude)');
        expect(prompt).toContain('- instruction: write_file via Write (claude)');
        expect(prompt).toMatchInlineSnapshot(`
          "You are an evaluation judge. Score the following agent session on a scale from 0.0 to 1.0 based on the rubric below.

          ## Session Transcript
          [User]
          Do the thing

          [Agent]
          Done

          ## Tool Events
          - turn 2: read_file via Read (claude)
          - instruction: write_file via Write (claude)

          ## Rubric
          Rate the helpfulness 0.0–1.0.

          Respond with ONLY a JSON object: {"score": <number>, "details": "<brief explanation>"}"
        `);
    });

    it('omits the Tool Events section when includeToolEvents is on but no events exist', () => {
        const scorer: JudgeScorer = { ...minimalJudge, includeToolEvents: true };
        const prompt = buildJudgePrompt(scorer, makeCtx());
        expect(prompt).not.toContain('## Tool Events');
    });

    it('renders resolved input fields as `## key` sections, JSON-stringifying non-string values', () => {
        const prompt = buildJudgePrompt(minimalJudge, makeCtx(), {
            expected: 'the user wants X',
            criteria: { a: 1, b: [2, 3] },
        });
        expect(prompt).toContain('## expected\nthe user wants X');
        expect(prompt).toContain('## criteria\n');
        expect(prompt).toContain('"a": 1');
        expect(prompt).toContain('"b": [');
    });
});

describe('buildBatchedJudgePrompt', () => {
    const a: JudgeScorer = { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' };
    const b: JudgeScorer = { type: 'judge', name: 'safety', weight: 1, rubric: 'Rate safety' };

    it('orders rubrics 1..N by input order, asks for array response with details field', () => {
        const prompt = buildBatchedJudgePrompt([a, b], makeCtx(), [undefined, undefined]);
        expect(prompt).toContain('### Rubric 1: "quality"');
        expect(prompt).toContain('### Rubric 2: "safety"');
        expect(prompt).toContain('"scorer_name"');
        expect(prompt).toContain('"details"');
        expect(prompt).not.toContain('"reasoning"');
        expect(prompt).toMatchInlineSnapshot(`
          "You are an evaluation judge. Score the following agent session on each rubric below, from 0.0 to 1.0.

          ## Session Transcript
          [User]
          Do the thing

          [Agent]
          Done

          ### Rubric 1: "quality"
          Rate quality

          ### Rubric 2: "safety"
          Rate safety

          Respond with ONLY a JSON array, one entry per rubric in order:
          [{"scorer_name": "<name>", "score": <number>, "details": "<brief explanation>"}, ...]"
        `);
    });

    it('includes Tool Events section when ANY judge opts in', () => {
        const bWithEvents: JudgeScorer = { ...b, includeToolEvents: true };
        const ctx = makeCtx({
            toolEvents: [
                { turnNumber: 1, action: 'read_file', providerToolName: 'Read', provider: 'claude', summary: '', confidence: 'high', rawSnippet: '' },
            ],
        });
        const prompt = buildBatchedJudgePrompt([a, bWithEvents], ctx, [undefined, undefined]);
        expect(prompt).toContain('## Tool Events');
    });

    it('renders per-judge input fields under each rubric, JSON-stringifying non-strings', () => {
        const prompt = buildBatchedJudgePrompt([a, b], makeCtx(), [
            { expected: 'X' },
            { criteria: { key: 'val' } },
        ]);
        expect(prompt).toContain('### Rubric 1: "quality"');
        expect(prompt).toContain('#### expected\nX');
        expect(prompt).toContain('### Rubric 2: "safety"');
        expect(prompt).toContain('#### criteria\n');
        expect(prompt).toContain('"key": "val"');
    });
});

describe('buildToolUseJudgePrompt', () => {
    it('returns { system, user } with details in the system prompt and no reasoning anywhere', () => {
        const out = buildToolUseJudgePrompt(minimalJudge, makeCtx());
        expect(out.system).toContain('"details"');
        expect(out.system).not.toContain('"reasoning"');
        expect(out.user).toContain('## Session Transcript');
        expect(out.user).toContain('## Rubric');
        expect(out.user).toContain('Rate the helpfulness');
        expect(out.system).toMatchInlineSnapshot(`
          "You are an evaluation judge with access to workspace-reading tools.
          Use the tools to gather the evidence you need before scoring.
          When you have enough evidence, reply with a final score as a fenced JSON block:
          \`\`\`json
          {"score": <number 0..1>, "details": "<one-paragraph rationale citing evidence>"}
          \`\`\`
          Do not include any other text after the JSON block."
        `);
        expect(out.user).toMatchInlineSnapshot(`
          "## Session Transcript

          [User]
          Do the thing

          [Agent]
          Done

          ## Rubric

          Rate the helpfulness 0.0–1.0."
        `);
    });

    it('includes tool events in the user prompt when includeToolEvents is on', () => {
        const scorer: JudgeScorer = { ...minimalJudge, includeToolEvents: true };
        const ctx = makeCtx({
            toolEvents: [
                { turnNumber: 1, action: 'read_file', providerToolName: 'Read', provider: 'claude', summary: '', confidence: 'high', rawSnippet: '' },
            ],
        });
        const out = buildToolUseJudgePrompt(scorer, ctx);
        expect(out.user).toContain('## Tool Events');
        expect(out.user).toContain('- turn 1: read_file via Read (claude)');
    });
});

describe('response-field invariant across all three builders', () => {
    it('every prompt body asks for "details", none say "reasoning"', () => {
        const scorer = minimalJudge;
        const ctx = makeCtx();
        const plain = buildJudgePrompt(scorer, ctx);
        const batched = buildBatchedJudgePrompt([scorer], ctx, [undefined]);
        const tool = buildToolUseJudgePrompt(scorer, ctx);
        for (const body of [plain, batched, tool.system, tool.user]) {
            expect(body).not.toContain('"reasoning"');
        }
        // system (tool-use) + plain + batched all ask for details
        expect(plain).toContain('"details"');
        expect(batched).toContain('"details"');
        expect(tool.system).toContain('"details"');
    });
});
