import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callLLM } from '../src/utils/llm';

// Mock the cli-llm module
vi.mock('../src/utils/cli-llm', () => ({
    isClaudeCliAvailable: vi.fn(),
    callClaudeCli: vi.fn(),
}));

import { isClaudeCliAvailable, callClaudeCli } from '../src/utils/cli-llm';

const mockIsAvailable = vi.mocked(isClaudeCliAvailable);
const mockCallCli = vi.mocked(callClaudeCli);

// Save real env keys and clear them so tests control key availability
const envKeysToIsolate = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;

describe('callLLM CLI-first fallback', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
        vi.resetAllMocks();
        // Isolate from real API keys in process.env
        for (const key of envKeysToIsolate) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const key of envKeysToIsolate) {
            if (savedEnv[key] !== undefined) {
                process.env[key] = savedEnv[key];
            }
        }
    });

    it('tries CLI when no API keys are available and claude is installed', async () => {
        mockIsAvailable.mockResolvedValue(true);
        mockCallCli.mockResolvedValue({ text: 'hello', provider: 'cli', model: 'claude-cli' });

        const result = await callLLM('test prompt', { env: {} });
        expect(mockCallCli).toHaveBeenCalledWith('test prompt', {});
        expect(result.provider).toBe('cli');
    });

    it('falls back to API keys when CLI is not available', async () => {
        mockIsAvailable.mockResolvedValue(false);
        // No API keys in env → should throw
        await expect(callLLM('test', { env: {} })).rejects.toThrow();
        expect(mockCallCli).not.toHaveBeenCalled();
    });

    it('prefers CLI over API keys when CLI is available', async () => {
        // CLI is always preferred when available, even if API keys are present.
        // API keys are only used when CLI is unavailable or a non-Claude model is requested.
        mockIsAvailable.mockResolvedValue(true);
        mockCallCli.mockResolvedValue({ text: 'cli response', provider: 'cli', model: 'claude-cli' });

        const result = await callLLM('test', {
            env: { ANTHROPIC_API_KEY: 'sk-test-key' },
        });
        expect(mockCallCli).toHaveBeenCalled();
        expect(result.provider).toBe('cli');
    });

    it('skips CLI when opts.model specifies a non-Claude model', async () => {
        mockIsAvailable.mockResolvedValue(true);
        // model: 'gemini-flash' should NOT use CLI — it's not a Claude model
        // Without API keys this should throw, not silently substitute Claude
        await expect(callLLM('test', { model: 'gemini-flash', env: {} })).rejects.toThrow();
        expect(mockCallCli).not.toHaveBeenCalled();
    });

    it('forwards jsonSchema to callClaudeCli', async () => {
        mockIsAvailable.mockResolvedValue(true);
        const schema = '{"type":"object"}';
        mockCallCli.mockResolvedValue({ text: '{}', provider: 'cli', model: 'claude-cli' });

        await callLLM('test', { env: {}, jsonSchema: schema });
        expect(mockCallCli).toHaveBeenCalledWith('test', { jsonSchema: schema });
    });

    it('forwards opts.model to callClaudeCli when it is a Claude model', async () => {
        mockIsAvailable.mockResolvedValue(true);
        mockCallCli.mockResolvedValue({ text: 'hi', provider: 'cli', model: 'claude-sonnet-4' });

        await callLLM('test', { env: {}, model: 'claude-sonnet-4-20250514' });
        expect(mockCallCli).toHaveBeenCalledWith('test', { model: 'claude-sonnet-4-20250514' });
    });
});
