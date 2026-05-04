import { describe, it, expect, expectTypeOf } from 'vitest';
import { toAskUserToolEvent, type AskUserToolEvent } from '../src/sdk/ask-bus/projection.js';
import type { AskBatchSnapshot } from '../src/sdk/ask-bus/types.js';

function makeSnapshot(overrides: Partial<AskBatchSnapshot> = {}): AskBatchSnapshot {
    return {
        batchId: 'batch-1',
        turnNumber: 1,
        source: 'claude',
        lifecycle: 'post-hoc',
        sourceTool: 'AskUserQuestion',
        questions: [
            {
                id: 'q1',
                header: 'Region',
                question: 'Which region?',
                options: null,
                isOther: false,
                isSecret: false,
            },
        ],
        resolution: null,
        ...overrides,
    };
}

describe('toAskUserToolEvent — basic shape', () => {
    it('projects a minimal snapshot to a ToolEvent with action=ask_user and plural arguments', () => {
        const event = toAskUserToolEvent(makeSnapshot());

        expect(event.action).toBe('ask_user');
        expect(event.providerToolName).toBe('AskUserQuestion');
        expect(event.provider).toBe('claude');
        expect(event.turnNumber).toBe(1);
        expect(event.arguments).toEqual({
            batchId: 'batch-1',
            questions: [
                {
                    id: 'q1',
                    header: 'Region',
                    question: 'Which region?',
                    isOther: false,
                    isSecret: false,
                    options: null,
                },
            ],
        });
    });

    it('omits the answer field on questions when resolution is null', () => {
        const event = toAskUserToolEvent(makeSnapshot({ resolution: null }));
        const args = event.arguments as unknown as { questions: Array<Record<string, unknown>> };
        expect(args.questions[0]).not.toHaveProperty('answer');
    });

    it('preserves question order and within-question option order from the snapshot', () => {
        const snapshot = makeSnapshot({
            questions: [
                { id: 'qA', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }], isOther: false, isSecret: false },
                { id: 'qB', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }], isOther: false, isSecret: false },
            ],
        });

        const event = toAskUserToolEvent(snapshot);
        const args = event.arguments as unknown as { questions: Array<{ id: string; options: Array<{ label: string }> | null }> };

        expect(args.questions.map((q) => q.id)).toEqual(['qA', 'qB']);
        expect(args.questions[0].options!.map((o) => o.label)).toEqual(['a1', 'a2']);
        expect(args.questions[1].options!.map((o) => o.label)).toEqual(['b1', 'b2', 'b3']);
    });

    it('attaches answers to questions by questionId; unmatched questions have no answer', () => {
        const snapshot = makeSnapshot({
            questions: [
                { id: 'q1', question: 'q1?', options: null, isOther: false, isSecret: false },
                { id: 'q2', question: 'q2?', options: null, isOther: false, isSecret: false },
                { id: 'q3', question: 'q3?', options: null, isOther: false, isSecret: false },
            ],
            resolution: {
                answers: [
                    { questionId: 'q1', values: ['a1'], source: 'reaction' },
                    { questionId: 'q3', values: [], source: 'declined' },
                ],
            },
        });

        const event = toAskUserToolEvent(snapshot);
        const args = event.arguments as unknown as { questions: Array<Record<string, unknown>> };

        expect(args.questions[0].answer).toEqual({ values: ['a1'], source: 'reaction' });
        expect(args.questions[1]).not.toHaveProperty('answer');
        expect(args.questions[2].answer).toEqual({ values: [], source: 'declined' });
    });

    it('maps AskSource codex-app-server to ToolEvent.provider codex', () => {
        const event = toAskUserToolEvent(makeSnapshot({
            source: 'codex-app-server',
            lifecycle: 'live',
            sourceTool: 'request_user_input',
        }));
        expect(event.provider).toBe('codex');
        expect(event.providerToolName).toBe('request_user_input');
    });

    it('passes through bus-redacted values verbatim (projection is not a redaction seam)', () => {
        const snapshot = makeSnapshot({
            questions: [{ id: 'q1', question: 'secret?', options: null, isOther: false, isSecret: true }],
            resolution: {
                answers: [
                    // Bus already redacted this (isSecret + reaction).
                    { questionId: 'q1', values: ['<redacted>'], source: 'reaction' },
                ],
            },
        });

        const event = toAskUserToolEvent(snapshot);
        const args = event.arguments as unknown as { questions: Array<{ answer?: { values: string[] } }> };
        expect(args.questions[0].answer!.values).toEqual(['<redacted>']);
        expect(JSON.stringify(event)).not.toContain('rotate-me');
    });

    it('narrows arguments.questions[0].answer.source to the AskAnswerSource union', () => {
        const event: AskUserToolEvent = toAskUserToolEvent(makeSnapshot());
        expectTypeOf(event.action).toEqualTypeOf<'ask_user'>();
        expectTypeOf(event.arguments.questions[0].answer).toEqualTypeOf<
            { readonly values: readonly string[]; readonly source: 'reaction' | 'fallback' | 'declined' } | undefined
        >();
    });
});
