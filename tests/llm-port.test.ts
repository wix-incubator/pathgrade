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

    it('costUsd accumulates across addCost calls and surfaces zero before any addCost (#003)', async () => {
        // PRD §Token and cost telemetry: agent-turn costs are accumulated
        // onto the agent's shared telemetry object alongside token usage.
        // The Claude SDK driver feeds turn `costUsd` into `addCost` exactly
        // as it feeds `inputTokens`/`outputTokens` into `addTokens` today.
        const llm = createLLMClient({ adapters: [fakeAdapter({ name: 'cli' })] });
        expect(llm.costUsd).toBe(0);
        llm.addCost!(0.0125);
        llm.addCost!(0.0008);
        // Floating-point noise is acceptable — assert a tight numeric
        // tolerance rather than exact equality. Producers track costs in
        // SDK-reported decimals; consumers reconcile against the same.
        expect(llm.costUsd).toBeCloseTo(0.0133, 10);
    });

    it('addCost ignores non-finite or non-positive deltas defensively', async () => {
        // The SDK could in principle report 0 (free turn), NaN (corrupt),
        // or negative cost (refund? unlikely but cheap to guard). The
        // accumulator should never go backwards and should ignore garbage.
        const llm = createLLMClient({ adapters: [fakeAdapter({ name: 'cli' })] });
        llm.addCost!(0.01);
        llm.addCost!(0);            // 0 is a valid cost — accumulates
        llm.addCost!(NaN);          // ignored
        llm.addCost!(-0.5);         // ignored
        llm.addCost!(Infinity);     // ignored
        expect(llm.costUsd).toBeCloseTo(0.01, 10);
    });

    it('measure(fn) returns the cost delta consumed by fn, regardless of prior cost', async () => {
        // Mirrors the existing token-delta contract so `evaluate()` can
        // attribute conversation cost (pre-evaluate) separately from
        // judge-evaluate cost using the same `before.costUsd` snapshot.
        const llm = createLLMClient({ adapters: [fakeAdapter({ name: 'cli' })] });
        llm.addCost!(0.5);
        const { result, tokens, costUsd } = await llm.measure!(async () => {
            llm.addCost!(0.02);
            llm.addCost!(0.03);
            return 'done';
        });
        expect(result).toBe('done');
        expect(costUsd).toBeCloseTo(0.05, 10);
        expect(tokens).toEqual({ inputTokens: 0, outputTokens: 0 });
        expect(llm.costUsd).toBeCloseTo(0.55, 10);
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
