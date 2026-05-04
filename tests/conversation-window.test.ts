import { describe, it, expect, vi } from 'vitest';
import { createConversationWindow } from '../src/sdk/conversation-window.js';
import type { Message } from '../src/sdk/types.js';
import type { LLMPort } from '../src/utils/llm-types.js';

function makeMockLLM(text = 'Summary of earlier conversation.'): { llm: LLMPort; mockCall: ReturnType<typeof vi.fn> } {
    const mockCall = vi.fn().mockResolvedValue({
        text,
        provider: 'anthropic',
        model: 'test',
    });
    return { llm: { call: mockCall }, mockCall };
}

describe('ConversationWindow', () => {
    it('returns all messages verbatim when within window size', async () => {
        const { llm, mockCall } = makeMockLLM();
        const window = createConversationWindow({ windowSize: 4, llm });
        const messages: Message[] = [
            { role: 'user', content: 'Hello' },
            { role: 'agent', content: 'Hi there' },
            { role: 'user', content: 'How are you?' },
            { role: 'agent', content: 'Good, thanks!' },
        ];

        const history = await window.getHistory(messages);

        expect(history).toContain('Hello');
        expect(history).toContain('Hi there');
        expect(history).toContain('How are you?');
        expect(history).toContain('Good, thanks!');
        expect(mockCall).not.toHaveBeenCalled();
    });

    it('summarizes older messages when exceeding window size', async () => {
        const { llm, mockCall } = makeMockLLM();
        const window = createConversationWindow({ windowSize: 2, llm });
        const messages: Message[] = [
            { role: 'user', content: 'First question' },
            { role: 'agent', content: 'First answer' },
            { role: 'user', content: 'Second question' },
            { role: 'agent', content: 'Second answer' },
            { role: 'user', content: 'Third question' },
            { role: 'agent', content: 'Third answer' },
        ];

        const history = await window.getHistory(messages);

        expect(history).toContain('Third question');
        expect(history).toContain('Third answer');
        expect(history).not.toContain('First question');
        expect(history).not.toContain('First answer');
        expect(history).toContain('Summary');
        expect(mockCall).toHaveBeenCalledOnce();
    });

    it('caches summary — same messages do not re-summarize', async () => {
        const { llm, mockCall } = makeMockLLM();
        const window = createConversationWindow({ windowSize: 2, llm });
        const messages: Message[] = [
            { role: 'user', content: 'Old message' },
            { role: 'agent', content: 'Old reply' },
            { role: 'user', content: 'Recent message' },
            { role: 'agent', content: 'Recent reply' },
        ];

        await window.getHistory(messages);
        await window.getHistory(messages);

        expect(mockCall).toHaveBeenCalledOnce();
    });

    it('incremental summarization — new turns update existing summary', async () => {
        const { llm, mockCall } = makeMockLLM();
        const window = createConversationWindow({ windowSize: 2, llm });

        const messages1: Message[] = [
            { role: 'user', content: 'Turn 1' },
            { role: 'agent', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
            { role: 'agent', content: 'Reply 2' },
        ];
        await window.getHistory(messages1);
        expect(mockCall).toHaveBeenCalledOnce();

        const messages2: Message[] = [
            ...messages1,
            { role: 'user', content: 'Turn 3' },
            { role: 'agent', content: 'Reply 3' },
        ];
        await window.getHistory(messages2);
        expect(mockCall).toHaveBeenCalledTimes(2);

        const secondPrompt = mockCall.mock.calls[1][0];
        expect(secondPrompt).toContain('Previous summary');
    });
});
