import { describe, it, expect } from 'vitest';
import {
    isClaudeCliAvailable,
    callClaudeCli,
    resetCliCache,
    extractStructuredOutput,
} from '../src/utils/cli-llm';

describe('isClaudeCliAvailable', () => {
    it('returns a boolean', async () => {
        const result = await isClaudeCliAvailable();
        expect(typeof result).toBe('boolean');
    });
});

describe('callClaudeCli', () => {
    it('returns text for plain prompt', async () => {
        if (!await isClaudeCliAvailable()) return;
        const result = await callClaudeCli('Reply with exactly: hello');
        expect(result.text).toBeTruthy();
        expect(result.provider).toBe('cli');
    }, 30_000);

    it('returns parsed JSON for structured prompt', async () => {
        if (!await isClaudeCliAvailable()) return;
        const schema = JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        });
        const result = await callClaudeCli('What is 2+2? Put the answer in the answer field.', {
            jsonSchema: schema,
        });
        const parsed = JSON.parse(result.text);
        expect(parsed.answer).toBeDefined();
    }, 30_000);
});

describe('extractStructuredOutput', () => {
    it('extracts structured_output from Claude envelope', () => {
        const envelope = JSON.stringify({
            type: 'result',
            structured_output: { score: 0.8, reasoning: 'good' },
            result: 'fallback text',
        });
        const result = extractStructuredOutput(envelope);
        expect(JSON.parse(result)).toEqual({ score: 0.8, reasoning: 'good' });
    });

    it('falls back to result field when structured_output is absent', () => {
        const envelope = JSON.stringify({
            type: 'result',
            result: 'plain text response',
        });
        const result = extractStructuredOutput(envelope);
        expect(result).toBe('plain text response');
    });

    it('handles stdout with prefix text before JSON', () => {
        const raw = 'Some debug line\n{"type":"result","structured_output":{"answer":"4"}}';
        const result = extractStructuredOutput(raw);
        expect(JSON.parse(result)).toEqual({ answer: '4' });
    });

    it('returns raw when no JSON found', () => {
        const result = extractStructuredOutput('not json at all');
        expect(result).toBe('not json at all');
    });
});
