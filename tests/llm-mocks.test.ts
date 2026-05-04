import { describe, it, expect } from 'vitest';
import { createMockLLM } from '../src/utils/llm-mocks.js';

describe('createMockLLM', () => {
    it('returns canned responses in order from call()', async () => {
        const llm = createMockLLM({
            responses: [
                { text: 'first', inputTokens: 10, outputTokens: 2 },
                { text: 'second', inputTokens: 20, outputTokens: 4 },
            ],
        });

        const r1 = await llm.call('p1');
        const r2 = await llm.call('p2');

        expect(r1.text).toBe('first');
        expect(r2.text).toBe('second');
    });

    it('accumulates tokenUsage across call()s', async () => {
        const llm = createMockLLM({
            responses: [
                { text: 'a', inputTokens: 10, outputTokens: 2 },
                { text: 'b', inputTokens: 20, outputTokens: 4 },
            ],
        });

        await llm.call('p');
        await llm.call('p');

        expect(llm.tokenUsage).toEqual({ inputTokens: 30, outputTokens: 6 });
    });

    it('throws when out of responses', async () => {
        const llm = createMockLLM({ responses: [{ text: 'only' }] });

        await llm.call('p');

        await expect(llm.call('p')).rejects.toThrow(/out of responses.*call #2/);
    });

    it('queueResponse appends responses mid-test', async () => {
        const llm = createMockLLM();
        llm.queueResponse({ text: 'late' });

        const r = await llm.call('p');

        expect(r.text).toBe('late');
    });

    it('accepts string shorthand for text-only responses', async () => {
        const llm = createMockLLM({ responses: ['hello', 'world'] });

        expect((await llm.call('p')).text).toBe('hello');
        expect((await llm.call('p')).text).toBe('world');
    });

    it('callWithTools returns tool_use and final responses in order', async () => {
        const llm = createMockLLM({
            responses: [
                {
                    kind: 'tool_use',
                    blocks: [{ type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'x' } }],
                    inputTokens: 50,
                    outputTokens: 5,
                },
                { kind: 'final', text: 'done', inputTokens: 100, outputTokens: 10 },
            ],
        });

        const r1 = await llm.callWithTools!([{ role: 'user', content: 'x' }], { tools: [] });
        const r2 = await llm.callWithTools!([{ role: 'user', content: 'x' }], { tools: [] });

        expect(r1.kind).toBe('tool_use');
        expect(r2.kind).toBe('final');
        expect(llm.tokenUsage).toEqual({ inputTokens: 150, outputTokens: 15 });
    });

    it('rejects cross-kind consumption of the response queue', async () => {
        const toolOnly = createMockLLM({ responses: [{ kind: 'final', text: 'done' }] });
        await expect(toolOnly.call('p')).rejects.toThrow(/tool-use response/);

        const plainOnly = createMockLLM({ responses: [{ text: 'plain' }] });
        await expect(
            plainOnly.callWithTools!([{ role: 'user', content: 'x' }], { tools: [] }),
        ).rejects.toThrow(/kind='tool_use' or kind='final'/);
    });

    it('records each call in .calls for assertion on prompt / opts', async () => {
        const llm = createMockLLM({ responses: ['r1', 'r2'] });

        await llm.call('prompt-1', { model: 'x' });
        await llm.call('prompt-2');

        expect(llm.calls).toHaveLength(2);
        expect(llm.calls[0].prompt).toBe('prompt-1');
        expect(llm.calls[0].opts?.model).toBe('x');
        expect(llm.calls[1].prompt).toBe('prompt-2');
    });

    it('records callWithTools in .toolCalls', async () => {
        const llm = createMockLLM({ responses: [{ kind: 'final', text: 'ok' }] });
        const messages = [{ role: 'user' as const, content: 'x' }];
        await llm.callWithTools!(messages, { tools: [] });
        expect(llm.toolCalls).toHaveLength(1);
        expect(llm.toolCalls[0].messages).toBe(messages);
    });

    it('{ throws } response rejects the call', async () => {
        const err = new Error('LLM down');
        const llm = createMockLLM({ responses: [{ throws: err }] });
        await expect(llm.call('p')).rejects.toBe(err);
    });

    it('defaultResponse is used when the queue is empty', async () => {
        const llm = createMockLLM({
            responses: [{ text: 'first' }],
            defaultResponse: { text: 'fallback' },
        });

        expect((await llm.call('p')).text).toBe('first');
        expect((await llm.call('p')).text).toBe('fallback');
        expect((await llm.call('p')).text).toBe('fallback');
    });

    it('respond callback overrides the queue for dynamic tests', async () => {
        const seen: string[] = [];
        const llm = createMockLLM({
            respond: (prompt) => {
                seen.push(prompt);
                return { text: `echo:${prompt}` };
            },
        });

        const r = await llm.call('hello');
        expect(r.text).toBe('echo:hello');
        expect(seen).toEqual(['hello']);
    });

});
