import type { LLMProvider, LLMCallOptions, LLMCallResult } from '../llm-types.js';

interface OpenAIResponse {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function getApiKey(env?: Record<string, string>): string | undefined {
    return env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
}

export const openaiProvider: LLMProvider = {
    name: 'openai',

    async isAvailable(env?: Record<string, string>): Promise<boolean> {
        return !!getApiKey(env);
    },

    supportsModel(model: string): boolean {
        const normalized = model.trim().toLowerCase();
        return (
            normalized.startsWith('gpt-')
            || normalized.startsWith('chatgpt-')
            || normalized.startsWith('o1')
            || normalized.startsWith('o3')
            || normalized.startsWith('o4')
        );
    },

    async call(prompt: string, opts: LLMCallOptions): Promise<LLMCallResult> {
        const apiKey = getApiKey(opts.env);
        if (!apiKey) {
            throw new Error('No OPENAI_API_KEY available');
        }

        const model = opts.model || 'gpt-4o';
        const temperature = opts.temperature ?? 0;
        const baseUrl = (opts.env?.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

        try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 4096,
                    temperature,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`OpenAI API error (${response.status}): ${errBody.slice(0, 300)}`);
            }

            const data = await response.json() as OpenAIResponse;
            return {
                text: data?.choices?.[0]?.message?.content || '',
                inputTokens: data?.usage?.prompt_tokens,
                outputTokens: data?.usage?.completion_tokens,
                provider: 'openai',
                model,
            };
        } catch (error) {
            throw new Error(`OpenAI API error: ${error}`);
        }
    },
};
