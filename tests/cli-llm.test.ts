import { describe, it, expect, vi } from 'vitest';
import {
    isClaudeCliAvailable,
    resetCliCache,
    extractStructuredOutput,
    parseCliEnvelope,
} from '../src/utils/llm-providers/cli.js';
import { createLLMClient } from '../src/utils/llm.js';
import type { LLMProvider } from '../src/utils/llm-types.js';

describe('isClaudeCliAvailable', () => {
    it('returns a boolean', async () => {
        const result = await isClaudeCliAvailable();
        expect(typeof result).toBe('boolean');
    });
});

describe('callLLM via CLI', () => {
    function makeFakeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
        return {
            name: 'cli',
            isAvailable: vi.fn().mockResolvedValue(true),
            call: vi.fn().mockResolvedValue({
                text: 'hello',
                provider: 'cli',
                model: 'claude-cli',
                inputTokens: 10,
                outputTokens: 5,
            }),
            ...overrides,
        };
    }

    it('returns text for plain prompt', async () => {
        const provider = makeFakeProvider();
        const client = createLLMClient([provider]);
        const result = await client.call('Reply with exactly: hello');
        expect(result.text).toBeTruthy();
        expect(result.provider).toBe('cli');
        expect(provider.call).toHaveBeenCalledWith('Reply with exactly: hello', {});
    });

    it('returns parsed JSON for structured prompt', async () => {
        const schema = JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        });
        const provider = makeFakeProvider({
            call: vi.fn().mockResolvedValue({
                text: JSON.stringify({ answer: '4' }),
                provider: 'cli',
                model: 'claude-cli',
            }),
        });
        const client = createLLMClient([provider]);
        const result = await client.call('What is 2+2?', { jsonSchema: schema });
        const parsed = JSON.parse(result.text);
        expect(parsed.answer).toBeDefined();
    });

    it('falls through to next provider when first is unavailable', async () => {
        const unavailable = makeFakeProvider({
            isAvailable: vi.fn().mockResolvedValue(false),
        });
        const fallback = makeFakeProvider({
            name: 'anthropic',
            call: vi.fn().mockResolvedValue({
                text: 'from fallback',
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
            }),
        });
        const client = createLLMClient([unavailable, fallback]);
        const result = await client.call('hello');
        expect(result.provider).toBe('anthropic');
        expect(unavailable.call).not.toHaveBeenCalled();
    });
});

describe('parseCliEnvelope', () => {
    it('parses a full CLI JSON envelope with usage', () => {
        const raw = JSON.stringify({
            type: 'result',
            result: 'hello world',
            usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 10,
            },
        });
        const envelope = parseCliEnvelope(raw);
        expect(envelope.result).toBe('hello world');
        expect(envelope.usage?.input_tokens).toBe(100);
        expect(envelope.usage?.output_tokens).toBe(50);
        expect(envelope.usage?.cache_creation_input_tokens).toBe(20);
        expect(envelope.usage?.cache_read_input_tokens).toBe(10);
    });

    it('parses envelope with structured_output', () => {
        const raw = JSON.stringify({
            type: 'result',
            structured_output: { score: 0.9 },
            usage: { input_tokens: 80, output_tokens: 30 },
        });
        const envelope = parseCliEnvelope(raw);
        expect(envelope.structured_output).toEqual({ score: 0.9 });
        expect(envelope.usage?.input_tokens).toBe(80);
    });

    it('returns empty object when no JSON found', () => {
        expect(parseCliEnvelope('not json at all')).toEqual({});
    });

    it('returns empty object for malformed JSON', () => {
        expect(parseCliEnvelope('{broken json')).toEqual({});
    });

    it('handles stdout with prefix text before JSON', () => {
        const raw = 'Debug line\n{"result":"parsed","usage":{"input_tokens":10,"output_tokens":5}}';
        const envelope = parseCliEnvelope(raw);
        expect(envelope.result).toBe('parsed');
        expect(envelope.usage?.input_tokens).toBe(10);
    });
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
