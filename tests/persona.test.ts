import { describe, it, expect, vi } from 'vitest';
import { createPersona } from '../src/sdk/persona.js';
import type { LLMPort } from '../src/utils/llm-types.js';
import type { LLMCallResult } from '../src/utils/llm-types.js';

const DEFAULT_REPLY: LLMCallResult = {
    text: 'Sure, I can help with that.',
    provider: 'anthropic',
    model: 'test',
};

function makeMockLLM(...responses: LLMCallResult[]): { llm: LLMPort; mockCall: ReturnType<typeof vi.fn> } {
    const mockCall = vi.fn();
    if (responses.length === 0) {
        mockCall.mockResolvedValue(DEFAULT_REPLY);
    } else if (responses.length === 1) {
        mockCall.mockResolvedValue(responses[0]);
    } else {
        for (const r of responses) {
            mockCall.mockResolvedValueOnce(r);
        }
    }
    return { llm: { call: mockCall }, mockCall };
}

describe('persona', () => {
    const fakeChatSession = {
        turn: 1,
        done: false,
        lastMessage: 'Hello, how can I help you?',
        messages: [
            { role: 'user' as const, content: 'I want to build a gift card feature.' },
            { role: 'agent' as const, content: 'Hello, how can I help you?' },
        ],
        reply: vi.fn(),
        hasFile: vi.fn(),
        end: vi.fn(),
    };

    it('prompt includes description and facts', async () => {
        const { llm, mockCall } = makeMockLLM();
        const persona = createPersona({
            description: 'You are a PM at Acme with 3 years on Stores.',
            facts: ['Feature is for Acme Stores', 'Budget is limited'],
            llm,
        });

        await persona.reply(fakeChatSession);

        expect(mockCall).toHaveBeenCalledOnce();
        const prompt = mockCall.mock.calls[0][0];
        expect(prompt).toContain('You are a PM at Acme with 3 years on Stores.');
        expect(prompt).toContain('Feature is for Acme Stores');
        expect(prompt).toContain('Budget is limited');
    });

    it('model override respected', async () => {
        const { llm, mockCall } = makeMockLLM();
        const persona = createPersona({
            description: 'A PM',
            facts: ['Fact A'],
            model: 'claude-sonnet-4-20250514',
            llm,
        });

        await persona.reply(fakeChatSession);

        expect(mockCall).toHaveBeenCalledOnce();
        const opts = mockCall.mock.calls[0][1];
        expect(opts).toEqual(expect.objectContaining({ model: 'claude-sonnet-4-20250514' }));
    });

    it('no model uses default (undefined)', async () => {
        const { llm, mockCall } = makeMockLLM();
        const persona = createPersona({
            description: 'A PM',
            facts: ['Fact A'],
            llm,
        });

        await persona.reply(fakeChatSession);

        const opts = mockCall.mock.calls[0][1];
        expect(opts?.model).toBeUndefined();
    });

    it('returns LLM response string trimmed', async () => {
        const { llm } = makeMockLLM({
            text: '  That sounds like a great approach!  ',
            provider: 'anthropic',
            model: 'test',
        });

        const persona = createPersona({
            description: 'A PM',
            facts: ['Fact A'],
            llm,
        });

        const reply = await persona.reply(fakeChatSession);

        expect(reply).toBe('That sounds like a great approach!');
    });

    it('prompt includes message history from chat.messages', async () => {
        const { llm, mockCall } = makeMockLLM(
            { text: 'Summary of earlier messages.', provider: 'anthropic', model: 'test' },
            DEFAULT_REPLY,
        );

        const multiTurnChat = {
            ...fakeChatSession,
            turn: 3,
            lastMessage: 'What platform is this for?',
            messages: [
                { role: 'user' as const, content: 'I want to build a gift card feature.' },
                { role: 'agent' as const, content: 'Great idea! What platform?' },
                { role: 'user' as const, content: 'Acme Stores.' },
                { role: 'agent' as const, content: 'Got it. What about budget?' },
                { role: 'user' as const, content: 'Limited budget.' },
                { role: 'agent' as const, content: 'What platform is this for?' },
            ],
        };

        const persona = createPersona({
            description: 'A PM',
            facts: ['Fact A'],
            llm,
        });

        await persona.reply(multiTurnChat);

        // 6 messages with default windowSize=4 → first 2 summarized, last 4 verbatim
        // calls[0] = summarization, calls[1] = persona reply
        const personaPrompt = mockCall.mock.calls[1][0];
        expect(personaPrompt).toContain('Acme Stores.');
        expect(personaPrompt).toContain('Got it. What about budget?');
        expect(personaPrompt).toContain('Limited budget.');
        expect(personaPrompt).toContain('What platform is this for?');

        expect(personaPrompt).toMatch(/User:.*Limited budget/s);
        expect(personaPrompt).toMatch(/Agent:.*What platform/s);
    });

    it('long conversations use sliding window — both summarization and reply use injected llm', async () => {
        const { llm, mockCall } = makeMockLLM(
            { text: 'Summary: discussed gift cards and platform choice.', provider: 'anthropic', model: 'test' },
            { text: 'That makes sense for the budget.', provider: 'anthropic', model: 'test' },
        );

        const longChat = {
            ...fakeChatSession,
            turn: 5,
            lastMessage: 'Last agent message',
            messages: [
                { role: 'user' as const, content: 'Turn 1 user' },
                { role: 'agent' as const, content: 'Turn 1 agent' },
                { role: 'user' as const, content: 'Turn 2 user' },
                { role: 'agent' as const, content: 'Turn 2 agent' },
                { role: 'user' as const, content: 'Turn 3 user' },
                { role: 'agent' as const, content: 'Turn 3 agent' },
                { role: 'user' as const, content: 'Turn 4 user' },
                { role: 'agent' as const, content: 'Turn 4 agent' },
                { role: 'user' as const, content: 'Turn 5 user' },
                { role: 'agent' as const, content: 'Turn 5 agent' },
            ],
        };

        const persona = createPersona({
            description: 'A PM',
            facts: ['Fact A'],
            llm,
        });

        await persona.reply(longChat);

        // Two LLM calls: one for summary, one for persona reply
        expect(mockCall).toHaveBeenCalledTimes(2);

        const personaPrompt = mockCall.mock.calls[1][0];
        expect(personaPrompt).toContain('Summary');
        expect(personaPrompt).toContain('Turn 5 user');
        expect(personaPrompt).toContain('Turn 5 agent');
        expect(personaPrompt).not.toContain('Turn 1 user');
    });
});
