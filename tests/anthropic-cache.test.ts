import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { anthropicProvider } from '../src/utils/llm-providers/anthropic.js';

// Capture fetch calls
const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
            content: [{ text: 'response' }],
            usage: { input_tokens: 100, output_tokens: 50 },
        }),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockFetch.mockReset();
});

describe('Anthropic prompt caching', () => {
    it('1: without cacheControl, sends plain string content', async () => {
        await anthropicProvider.call('test prompt', {});

        expect(mockFetch).toHaveBeenCalledOnce();
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        // Messages should use plain string content
        expect(body.messages[0].content).toBe('test prompt');
        // No beta header
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('2: with cacheControl, sends content blocks with cache_control', async () => {
        await anthropicProvider.call('test prompt', { cacheControl: true });

        expect(mockFetch).toHaveBeenCalledOnce();
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        // Messages should use content blocks with cache_control
        expect(body.messages[0].content).toEqual([
            {
                type: 'text',
                text: 'test prompt',
                cache_control: { type: 'ephemeral' },
            },
        ]);
        // Beta header should be present
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    });

    it('3: respects ANTHROPIC_BASE_URL environment variable', async () => {
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://custom.api.com');
        await anthropicProvider.call('test prompt', {});

        const url = mockFetch.mock.calls[0][0];
        expect(url).toBe('https://custom.api.com/v1/messages');
    });
});

describe('Anthropic callWithTools', () => {
    it('serializes messages + system + tools into /v1/messages', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'hi' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 3 },
            }),
        });

        const result = await anthropicProvider.callWithTools!(
            [{ role: 'user', content: 'please grade' }],
            {
                system: 'You are a judge.',
                tools: [{
                    name: 'readFile',
                    description: 'read a file',
                    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                }],
                model: 'claude-haiku-4-5-20251001',
            },
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.model).toBe('claude-haiku-4-5-20251001');
        expect(body.system).toBeDefined();
        expect(body.tools).toEqual([
            expect.objectContaining({ name: 'readFile', input_schema: expect.any(Object) }),
        ]);
        expect(body.messages).toEqual([{ role: 'user', content: 'please grade' }]);

        expect(result.kind).toBe('final');
        if (result.kind === 'final') {
            expect(result.text).toBe('hi');
        }
        expect(result.inputTokens).toBe(5);
        expect(result.outputTokens).toBe(3);
    });

    it('returns kind: tool_use when response contains a tool_use block (even with text)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [
                    { type: 'text', text: 'I will read the file' },
                    { type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'spec.md' } },
                ],
                stop_reason: 'tool_use',
                usage: { input_tokens: 10, output_tokens: 4 },
            }),
        });

        const result = await anthropicProvider.callWithTools!(
            [{ role: 'user', content: 'x' }],
            { tools: [] },
        );

        expect(result.kind).toBe('tool_use');
        if (result.kind === 'tool_use') {
            expect(result.blocks).toHaveLength(1);
            expect(result.blocks[0]).toMatchObject({ name: 'readFile', id: 't1', input: { path: 'spec.md' } });
            expect(result.text).toBe('I will read the file');
        }
    });

    it('marks system prompt and last tool schema with cache_control when cacheControl=true', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });

        await anthropicProvider.callWithTools!(
            [{ role: 'user', content: 'rate' }],
            {
                system: 'judge system',
                tools: [
                    { name: 'readFile', description: 'r', input_schema: { type: 'object' } },
                    { name: 'listDir', description: 'l', input_schema: { type: 'object' } },
                ],
                cacheControl: true,
            },
        );

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        // system becomes a content-block array with cache_control on the last block
        expect(Array.isArray(body.system)).toBe(true);
        expect(body.system.at(-1)).toMatchObject({
            type: 'text',
            text: 'judge system',
            cache_control: { type: 'ephemeral' },
        });
        // tool schemas: only the last gets cache_control (marks the breakpoint)
        expect(body.tools[0].cache_control).toBeUndefined();
        expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' });
        // messages are plain strings/blocks without cache_control anywhere
        expect(JSON.stringify(body.messages)).not.toContain('cache_control');
        // Beta header engaged
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['anthropic-beta']).toContain('prompt-caching');
    });

    it('includes cache_creation and cache_read tokens in the reported inputTokens', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 100,
                    output_tokens: 40,
                    cache_creation_input_tokens: 500,
                    cache_read_input_tokens: 200,
                },
            }),
        });

        const result = await anthropicProvider.callWithTools!(
            [{ role: 'user', content: 'x' }],
            { tools: [], cacheControl: true },
        );
        // 100 + 500 + 200 = 800
        expect(result.inputTokens).toBe(800);
        expect(result.outputTokens).toBe(40);
    });

    it('does not mark cache_control when cacheControl is false or unset', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });

        await anthropicProvider.callWithTools!(
            [{ role: 'user', content: 'x' }],
            {
                system: 's',
                tools: [{ name: 'readFile', description: 'r', input_schema: { type: 'object' } }],
                // cacheControl omitted
            },
        );

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(JSON.stringify(body)).not.toContain('cache_control');
    });

    it('passes assistant and user messages through (including tool_result blocks)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 0, output_tokens: 0 },
            }),
        });

        await anthropicProvider.callWithTools!(
            [
                { role: 'user', content: 'rate' },
                {
                    role: 'assistant', content: [
                        { type: 'text', text: 'reading' },
                        { type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'x' } },
                    ],
                },
                {
                    role: 'user', content: [
                        { type: 'tool_result', tool_use_id: 't1', content: 'file body', is_error: false },
                    ],
                },
            ],
            { tools: [] },
        );

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.messages).toHaveLength(3);
        expect(body.messages[1].content).toEqual([
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'x' } },
        ]);
        expect(body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    });
});
