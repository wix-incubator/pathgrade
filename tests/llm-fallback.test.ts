import { describe, it, expect, vi } from 'vitest';
import { createLLMClient, createAgentLLM } from '../src/utils/llm.js';
import type { LLMProvider, LLMCallResult } from '../src/utils/llm-types.js';

function fakeProvider(overrides: Partial<LLMProvider> & { name: string }): LLMProvider {
    return {
        isAvailable: async () => true,
        call: async () => ({ text: `${overrides.name} response`, provider: 'cli' as const, model: 'fake' }),
        ...overrides,
    };
}

describe('createLLMClient fallback chain', () => {
    it('tries CLI when no API keys are available and CLI is installed', async () => {
        const cliCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'hello', provider: 'cli', model: 'claude-cli',
        });
        const client = createLLMClient([
            fakeProvider({ name: 'cli', call: cliCall }),
        ]);

        const result = await client.call('test prompt', { env: {} });
        expect(cliCall).toHaveBeenCalledWith('test prompt', { env: {} });
        expect(result.provider).toBe('cli');
    });

    it('skips unavailable providers', async () => {
        const client = createLLMClient([
            fakeProvider({ name: 'cli', isAvailable: async () => false }),
        ]);

        await expect(client.call('test', { env: {} })).rejects.toThrow('No LLM backend');
    });

    it('prefers CLI over API providers when CLI is available', async () => {
        const cliCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'cli response', provider: 'cli', model: 'claude-cli',
        });
        const anthropicCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'anthropic response', provider: 'anthropic', model: 'claude-sonnet',
        });

        const client = createLLMClient([
            fakeProvider({ name: 'cli', call: cliCall }),
            fakeProvider({ name: 'anthropic', call: anthropicCall }),
        ]);

        const result = await client.call('test', { env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
        expect(cliCall).toHaveBeenCalled();
        expect(anthropicCall).not.toHaveBeenCalled();
        expect(result.provider).toBe('cli');
    });

    it('falls back to API provider when CLI invocation fails', async () => {
        const cliCall = vi.fn().mockRejectedValue(new Error('Claude CLI exited with code 1'));
        const anthropicCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'anthropic fallback', provider: 'anthropic', model: 'claude-sonnet',
        });

        const client = createLLMClient([
            fakeProvider({ name: 'cli', call: cliCall }),
            fakeProvider({ name: 'anthropic', call: anthropicCall }),
        ]);

        const result = await client.call('test', {});
        expect(cliCall).toHaveBeenCalled();
        expect(anthropicCall).toHaveBeenCalled();
        expect(result.provider).toBe('anthropic');
        expect(result.text).toBe('anthropic fallback');
    });

    it('skips CLI when opts.model specifies a non-Claude model', async () => {
        const cliCall = vi.fn<() => Promise<LLMCallResult>>();
        const openaiCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'openai response', provider: 'openai', model: 'gpt-4o',
        });

        const client = createLLMClient([
            fakeProvider({
                name: 'cli',
                call: cliCall,
                supportsModel: (m) => !m.startsWith('gpt-'),
            }),
            fakeProvider({
                name: 'openai',
                call: openaiCall,
                supportsModel: (m) => m.startsWith('gpt-'),
            }),
        ]);

        const result = await client.call('test', { model: 'gpt-4o' });
        expect(cliCall).not.toHaveBeenCalled();
        expect(openaiCall).toHaveBeenCalled();
        expect(result.provider).toBe('openai');
    });

    it('forwards opts to provider call', async () => {
        const cliCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: '{}', provider: 'cli', model: 'claude-cli',
        });

        const client = createLLMClient([
            fakeProvider({ name: 'cli', call: cliCall }),
        ]);

        const schema = '{"type":"object"}';
        await client.call('test', { env: {}, jsonSchema: schema });
        expect(cliCall).toHaveBeenCalledWith('test', { env: {}, jsonSchema: schema });
    });

    it('forwards model to provider call for Claude models', async () => {
        const cliCall = vi.fn<() => Promise<LLMCallResult>>().mockResolvedValue({
            text: 'hi', provider: 'cli', model: 'claude-sonnet-4',
        });

        const client = createLLMClient([
            fakeProvider({ name: 'cli', call: cliCall }),
        ]);

        await client.call('test', { env: {}, model: 'claude-sonnet-4-20250514' });
        expect(cliCall).toHaveBeenCalledWith('test', { env: {}, model: 'claude-sonnet-4-20250514' });
    });

    it('throws when no providers are available', async () => {
        const client = createLLMClient([
            fakeProvider({ name: 'cli', isAvailable: async () => false }),
            fakeProvider({ name: 'anthropic', isAvailable: async () => false }),
        ]);

        await expect(client.call('test')).rejects.toThrow('No LLM backend');
    });

    it('propagates error from single provider', async () => {
        const client = createLLMClient([
            fakeProvider({
                name: 'cli',
                call: vi.fn().mockRejectedValue(new Error('CLI broken')),
            }),
        ]);

        await expect(client.call('test')).rejects.toThrow('CLI broken');
    });
});

describe('createLLMClient tool-use forwarding', () => {
    it('exposes callWithTools when selected provider supports it', async () => {
        const mockCallWithTools = vi.fn().mockResolvedValue({
            kind: 'final', text: 'done', inputTokens: 1, outputTokens: 1,
        });
        const toolCapable: LLMProvider = fakeProvider({
            name: 'anthropic',
            callWithTools: mockCallWithTools,
        });
        const plainOnly: LLMProvider = fakeProvider({ name: 'cli' });

        const client = createLLMClient([plainOnly, toolCapable]);
        expect(typeof client.callWithTools).toBe('function');

        const result = await client.callWithTools!(
            [{ role: 'user', content: 'x' }],
            { tools: [], env: { ANTHROPIC_API_KEY: 'sk' } },
        );
        expect(result.kind).toBe('final');
        expect(mockCallWithTools).toHaveBeenCalledOnce();
    });

    it('does not expose callWithTools when no selected provider supports it', async () => {
        const client = createLLMClient([
            fakeProvider({ name: 'cli' }),
            fakeProvider({ name: 'openai' }),
        ]);
        // No env, no tool-capable provider
        expect(client.callWithTools).toBeUndefined();
    });
});

describe('createAgentLLM early CLI check', () => {
    it('throws a cursor-specific error when neither Claude CLI nor ANTHROPIC_API_KEY is available', async () => {
        const cliModule = await import('../src/utils/llm-providers/cli.js');
        cliModule.resetCliCache();
        const cliSpy = vi.spyOn(cliModule.cliProvider, 'isAvailable').mockResolvedValue(false);
        const anthropicModule = await import('../src/utils/llm-providers/anthropic.js');
        const anthropicSpy = vi.spyOn(anthropicModule.anthropicProvider, 'isAvailable').mockResolvedValue(false);

        try {
            const llm = createAgentLLM('cursor');
            await expect(llm.call('test')).rejects.toThrow(
                /Cursor eval requires a judge LLM.*ANTHROPIC_API_KEY.*Claude CLI/s,
            );
        } finally {
            cliSpy.mockRestore();
            anthropicSpy.mockRestore();
        }
    });

    it('throws a specific error when claude CLI is not available', async () => {
        const cliModule = await import('../src/utils/llm-providers/cli.js');
        cliModule.resetCliCache();
        const cliSpy = vi.spyOn(cliModule.cliProvider, 'isAvailable').mockResolvedValue(false);
        // Also isolate from ambient ANTHROPIC_API_KEY — otherwise the Anthropic HTTP
        // fallback picks up the shell's real key and the call resolves instead of rejecting.
        const anthropicModule = await import('../src/utils/llm-providers/anthropic.js');
        const anthropicSpy = vi.spyOn(anthropicModule.anthropicProvider, 'isAvailable').mockResolvedValue(false);

        try {
            const llm = createAgentLLM('claude');
            await expect(llm.call('test')).rejects.toThrow(/claude.*cli/i);
            // Should NOT be the generic "No LLM backend" message
            await expect(llm.call('test')).rejects.not.toThrow('No LLM backend');
        } finally {
            cliSpy.mockRestore();
            anthropicSpy.mockRestore();
        }
    });
});
