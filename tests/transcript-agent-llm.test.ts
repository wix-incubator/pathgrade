import { describe, it, expect, vi } from 'vitest';
import { CodexAgent } from '../src/agents/codex.js';
import type { CommandResult } from '../src/types.js';
import type { LLMPort } from '../src/utils/llm-types.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';
import type { Agent } from '../src/sdk/types.js';

// Mock the global callLLM so tests don't hit real providers
vi.mock('../src/utils/llm.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../src/utils/llm.js')>();
    return {
        ...mod,
        callLLM: vi.fn().mockResolvedValue({
            text: 'GLOBAL_FALLBACK_SUMMARY',
            provider: 'cli' as const,
            model: 'mock',
        }),
    };
});

describe('transcript-agent LLM propagation', () => {
    it('conversation window summarization uses LLM from session options (not global fallback)', async () => {
        const mockLLM: LLMPort = {
            call: vi.fn().mockResolvedValue({
                text: 'AGENT_SCOPED_SUMMARY',
                provider: 'test' as const,
                model: 'test',
            }),
        };

        const agent = new CodexAgent();
        let turnCount = 0;
        const mockRunCommand = vi.fn().mockImplementation(async (): Promise<CommandResult> => {
            turnCount++;
            return { stdout: `Response ${turnCount}`, stderr: '', exitCode: 0 };
        });

        // windowSize: 2 → after 3 turn pairs (6 msgs), oldest 4 get summarized
        const session = await agent.createSession('/workspace', mockRunCommand, {
            llm: mockLLM,
            conversationWindow: { windowSize: 2 },
        });

        await session.start({ message: 'Turn 1' });
        await session.reply({ message: 'Turn 2' });
        await session.reply({ message: 'Turn 3' });

        // Agent-scoped LLM should be used, not the global fallback
        expect(mockLLM.call).toHaveBeenCalled();
    });

    it('Agent interface requires llm property as an LLMPort with token tracking', () => {
        const trackedLLM = createMockLLM();
        const agent: Agent = {
            workspace: '/fake',
            log: [],
            messages: [],
            llm: trackedLLM,
            transcript: () => '',
            exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            prompt: async () => '',
            startChat: async () => { throw new Error('stub'); },
            runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
            dispose: async () => {},
        };
        expect(agent.llm).toBe(trackedLLM);
        expect(agent.llm.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('summarization tokens accumulate on the tracked LLM passed via options', async () => {
        const trackedLLM = createMockLLM({
            defaultResponse: {
                text: 'Summary',
                provider: 'anthropic',
                model: 'test',
                inputTokens: 100,
                outputTokens: 20,
            },
        });

        const agent = new CodexAgent();
        let turnCount = 0;
        const mockRunCommand = vi.fn().mockImplementation(async (): Promise<CommandResult> => {
            turnCount++;
            return { stdout: `Response ${turnCount}`, stderr: '', exitCode: 0 };
        });

        const session = await agent.createSession('/workspace', mockRunCommand, {
            llm: trackedLLM,
            conversationWindow: { windowSize: 2 },
        });

        await session.start({ message: 'Turn 1' });
        await session.reply({ message: 'Turn 2' });
        await session.reply({ message: 'Turn 3' });

        // Token usage from summarization should be tracked
        expect(trackedLLM.tokenUsage!.inputTokens).toBeGreaterThan(0);
        expect(trackedLLM.tokenUsage!.outputTokens).toBeGreaterThan(0);
    });
});
