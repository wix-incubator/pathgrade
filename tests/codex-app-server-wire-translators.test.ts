import { describe, expect, it, vi } from 'vitest';
import {
    normalizeUpstreamQuestion,
    toWireAnswerMap,
} from '../src/agents/codex-app-server/wire-translators.js';
import type { ToolRequestUserInputQuestion } from '../src/agents/codex-app-server/protocol/index.js';
import type { AskResolution } from '../src/sdk/ask-bus/types.js';

function makeUpstream(
    overrides: Partial<ToolRequestUserInputQuestion> = {},
): ToolRequestUserInputQuestion {
    return {
        id: 'q1',
        header: 'Which region?',
        question: 'Pick a region',
        isOther: false,
        isSecret: false,
        options: [{ label: 'us-east-1', description: 'North Virginia' }],
        ...overrides,
    };
}

describe('normalizeUpstreamQuestion', () => {
    it('copies id, question, isOther, isSecret verbatim', () => {
        const out = normalizeUpstreamQuestion(
            makeUpstream({ id: 'custom-id', question: 'hi', isOther: true, isSecret: true }),
        );
        expect(out.id).toBe('custom-id');
        expect(out.question).toBe('hi');
        expect(out.isOther).toBe(true);
        expect(out.isSecret).toBe(true);
    });

    it('preserves empty-string header (not coerced to undefined)', () => {
        const out = normalizeUpstreamQuestion(makeUpstream({ header: '' }));
        expect(out.header).toBe('');
    });

    it('passes through a non-empty header verbatim', () => {
        const out = normalizeUpstreamQuestion(makeUpstream({ header: 'Region' }));
        expect(out.header).toBe('Region');
    });

    it('preserves null options as null', () => {
        const out = normalizeUpstreamQuestion(makeUpstream({ options: null }));
        expect(out.options).toBeNull();
    });

    it('preserves option order and empty-string description', () => {
        const out = normalizeUpstreamQuestion(
            makeUpstream({
                options: [
                    { label: 'a', description: 'alpha' },
                    { label: 'b', description: '' },
                    { label: 'c', description: 'gamma' },
                ],
            }),
        );
        expect(out.options).toEqual([
            { label: 'a', description: 'alpha' },
            { label: 'b', description: '' },
            { label: 'c', description: 'gamma' },
        ]);
    });
});

describe('toWireAnswerMap', () => {
    const questions = [
        {
            id: 'q1',
            header: '',
            question: 'Region?',
            isOther: false,
            isSecret: false,
            options: null,
        },
        {
            id: 'q2',
            header: '',
            question: 'Password?',
            isOther: false,
            isSecret: true,
            options: null,
        },
    ] as const;

    it('projects a resolution into the wire shape keyed by questionId', () => {
        const resolution: AskResolution = {
            answers: [
                { questionId: 'q1', values: ['us-east-1'], source: 'reaction' },
                { questionId: 'q2', values: ['s3cr3t'], source: 'reaction' },
            ],
        };
        const wire = toWireAnswerMap(resolution, questions);
        expect(wire).toEqual({
            q1: { answers: ['us-east-1'] },
            q2: { answers: ['s3cr3t'] },
        });
    });

    it('passes isSecret values through raw (redaction is snapshot-side)', () => {
        const resolution: AskResolution = {
            answers: [
                { questionId: 'q1', values: ['ok'], source: 'reaction' },
                { questionId: 'q2', values: ['raw-secret'], source: 'reaction' },
            ],
        };
        const wire = toWireAnswerMap(resolution, questions);
        expect(wire.q2).toEqual({ answers: ['raw-secret'] });
    });

    it('declined source passes through as empty array', () => {
        const resolution: AskResolution = {
            answers: [
                { questionId: 'q1', values: [], source: 'declined' },
                { questionId: 'q2', values: [], source: 'declined' },
            ],
        };
        const wire = toWireAnswerMap(resolution, questions);
        expect(wire).toEqual({
            q1: { answers: [] },
            q2: { answers: [] },
        });
    });

    it('missing answer entry emits {answers: []} and warns', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const resolution: AskResolution = {
            answers: [
                { questionId: 'q1', values: ['x'], source: 'reaction' },
                // q2 missing
            ],
        };
        const wire = toWireAnswerMap(resolution, questions);
        expect(wire.q2).toEqual({ answers: [] });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('null resolution returns empty entries for every question and warns', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const wire = toWireAnswerMap(null, questions);
        expect(wire).toEqual({
            q1: { answers: [] },
            q2: { answers: [] },
        });
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('preserves multiple values in a single answer', () => {
        const oneQ = [questions[0]] as const;
        const resolution: AskResolution = {
            answers: [{ questionId: 'q1', values: ['a', 'b'], source: 'reaction' }],
        };
        expect(toWireAnswerMap(resolution, oneQ)).toEqual({
            q1: { answers: ['a', 'b'] },
        });
    });
});
