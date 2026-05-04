import type { LLMPort } from '../utils/llm-types.js';
import type { Message } from './types.js';

export interface ConversationWindowOptions {
    /** Number of recent messages (not turn pairs) to keep verbatim. Default: 4 */
    windowSize?: number;
    /** Model to use for summarization. Default: 'claude-haiku-4-5-20251001' */
    model?: string;
    /** LLM port for summarization calls. */
    llm?: LLMPort;
}

export interface ConversationWindow {
    getHistory(messages: Message[]): Promise<string>;
}

export function createConversationWindow(opts: ConversationWindowOptions = {}): ConversationWindow {
    const windowSize = opts.windowSize ?? 4;
    const model = opts.model ?? 'claude-haiku-4-5-20251001';
    const llm = opts.llm;

    let cachedSummary: string | null = null;
    let summarizedUpTo = 0; // number of messages already summarized

    return {
        async getHistory(messages: Message[]): Promise<string> {
            // If all messages fit within the window, return them verbatim
            if (messages.length <= windowSize) {
                return formatMessages(messages);
            }

            // No LLM — can't summarize, return all messages verbatim
            if (!llm) {
                return formatMessages(messages);
            }

            // Split: older messages get summarized, recent messages stay verbatim
            const cutoff = messages.length - windowSize;
            const olderMessages = messages.slice(0, cutoff);
            const recentMessages = messages.slice(cutoff);

            // Only re-summarize if there are new messages beyond what we've already summarized
            if (cutoff > summarizedUpTo || cachedSummary === null) {
                const toSummarize = cachedSummary
                    ? `Previous summary: ${cachedSummary}\n\nNew messages:\n${formatMessages(messages.slice(summarizedUpTo, cutoff))}`
                    : formatMessages(olderMessages);

                const response = await llm.call(
                    `Summarize this conversation concisely in one paragraph, preserving key facts and decisions:\n\n${toSummarize}`,
                    { model }
                );
                cachedSummary = response.text.trim();
                summarizedUpTo = cutoff;
            }

            return `## Earlier Context (Summary)\n${cachedSummary}\n\n## Recent Conversation\n${formatMessages(recentMessages)}`;
        },
    };
}

function formatMessages(messages: Message[]): string {
    return messages
        .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`)
        .join('\n\n');
}
