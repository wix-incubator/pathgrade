import type { LLMPort } from '../utils/llm-types.js';
import type { ChatSession, Persona, PersonaConfig } from './types.js';
import { createConversationWindow, type ConversationWindow } from './conversation-window.js';

export function createPersona(config: PersonaConfig & { llm: LLMPort }): Persona {
    const llm = config.llm;
    const window = config.conversationWindow !== false
        ? createConversationWindow({ ...config.conversationWindow, model: config.model, llm })
        : null;

    return {
        async reply(chat: ChatSession): Promise<string> {
            const prompt = await buildPrompt(config, chat, window);
            const response = await llm.call(prompt, { model: config.model });
            return response.text.trim();
        },
    };
}

function formatMessages(messages: import('./types.js').Message[]): string {
    return messages
        .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
        .join('\n\n');
}

async function buildPrompt(
    config: PersonaConfig,
    chat: ChatSession,
    window: ConversationWindow | null,
): Promise<string> {
    const sections: string[] = [];

    sections.push(`## Persona\n${config.description}`);

    if (config.facts.length > 0) {
        const factsList = config.facts.map(f => `- ${f}`).join('\n');
        sections.push(`## Facts\n${factsList}`);
    }

    const history = window
        ? await window.getHistory(chat.messages)
        : formatMessages(chat.messages);
    sections.push(`## Conversation History\n${history}`);

    sections.push('Reply in character as the persona described above. Respond to the agent\'s latest message naturally and concisely.');

    return sections.join('\n\n');
}
