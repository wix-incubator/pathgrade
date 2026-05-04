import { describe, it, expect, vi } from 'vitest';
import { createLLMClient } from '../src/utils/llm.js';
import type { LLMProviderAdapter, LLMCallResult } from '../src/utils/llm-types.js';

function fakeAdapter(overrides: Partial<LLMProviderAdapter> & { name: string }): LLMProviderAdapter {
    return {
        isAvailable: async () => true,
        call: async () => ({ text: 'ok', provider: 'cli', model: 'fake' }),
        ...overrides,
    };
}

describe('LLMPort — token accumulation', () => {
    it('tokenUsage accumulates across call, callWithTools, and addTokens', async () => {
        const call = vi.fn<() => Promise<LLMCallResult>>()
            .mockResolvedValueOnce({ text: 'a', provider: 'cli', model: 'fake', inputTokens: 100, outputTokens: 20 });
        const anthropic = fakeAdapter({
            name: 'anthropic',
            call,
            callWithTools: async () => ({
                kind: 'final', text: 'ok', inputTokens: 200, outputTokens: 40,
            }),
        });
        const llm = createLLMClient({ adapters: [anthropic] });

        await llm.call('prompt');
        await llm.callWithTools!([{ role: 'user', content: 'x' }], { tools: [] });
        llm.addTokens!(50, 10);

        expect(llm.tokenUsage).toEqual({ inputTokens: 350, outputTokens: 70 });
    });

    it('emits console.warn once when provider fallthrough occurs, deduped per transition', async () => {
        const cli = fakeAdapter({
            name: 'cli',
            call: vi.fn().mockRejectedValue(new Error('cli broken')),
        });
        const anthropic = fakeAdapter({
            name: 'anthropic',
            call: async () => ({ text: 'ok', provider: 'anthropic', model: 'm' }),
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const llm = createLLMClient({ adapters: [cli, anthropic] });
            await llm.call('a');
            await llm.call('b');
            await llm.call('c');
            expect(warn).toHaveBeenCalledTimes(1);
            const msg = warn.mock.calls[0][0] as string;
            expect(msg).toContain('pathgrade');
            expect(msg).toContain('fallthrough');
            expect(msg).toContain('cli');
            expect(msg).toContain('anthropic');
        } finally {
            warn.mockRestore();
        }
    });

    it('silent: true suppresses the fallthrough warn', async () => {
        const cli = fakeAdapter({
            name: 'cli',
            call: vi.fn().mockRejectedValue(new Error('cli broken')),
        });
        const anthropic = fakeAdapter({
            name: 'anthropic',
            call: async () => ({ text: 'ok', provider: 'anthropic', model: 'm' }),
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const llm = createLLMClient({ adapters: [cli, anthropic], silent: true });
            await llm.call('a');
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('lastProvider records the name of the adapter that resolved the last call', async () => {
        const cli = fakeAdapter({
            name: 'cli',
            call: async () => ({ text: 'cli', provider: 'cli', model: 'cli-model' }),
        });
        const anthropic = fakeAdapter({
            name: 'anthropic',
            call: async () => ({ text: 'anth', provider: 'anthropic', model: 'anth-model' }),
        });
        const llm = createLLMClient({ adapters: [cli, anthropic] });

        expect(llm.lastProvider).toBeUndefined();
        await llm.call('x');
        expect(llm.lastProvider).toBe('cli');
    });

    it('supportsToolUse is true iff any adapter implements callWithTools', async () => {
        const plain = createLLMClient({
            adapters: [fakeAdapter({ name: 'cli' })],
        });
        expect(plain.supportsToolUse).toBe(false);
        expect(plain.callWithTools).toBeUndefined();

        const withTools = createLLMClient({
            adapters: [
                fakeAdapter({ name: 'cli' }),
                fakeAdapter({
                    name: 'anthropic',
                    callWithTools: async () => ({ kind: 'final', text: 'ok' }),
                }),
            ],
        });
        expect(withTools.supportsToolUse).toBe(true);
        expect(typeof withTools.callWithTools).toBe('function');
    });

    it('measure(fn) returns the token delta consumed by fn, regardless of prior usage', async () => {
        const call = vi.fn<() => Promise<LLMCallResult>>()
            .mockResolvedValueOnce({
                text: 'priorr', provider: 'cli', model: 'fake',
                inputTokens: 1000, outputTokens: 500,
            })
            .mockResolvedValueOnce({
                text: 'a', provider: 'cli', model: 'fake',
                inputTokens: 40, outputTokens: 8,
            })
            .mockResolvedValueOnce({
                text: 'b', provider: 'cli', model: 'fake',
                inputTokens: 10, outputTokens: 2,
            });

        const llm = createLLMClient({ adapters: [fakeAdapter({ name: 'cli', call })] });

        // Burn some tokens first — measure must return delta, not cumulative
        await llm.call('prior');

        const { result, tokens } = await llm.measure!(async () => {
            await llm.call('a');
            await llm.call('b');
            return 'done';
        });

        expect(result).toBe('done');
        expect(tokens).toEqual({ inputTokens: 50, outputTokens: 10 });
        // Running total still reflects everything
        expect(llm.tokenUsage).toEqual({ inputTokens: 1050, outputTokens: 510 });
    });

});
