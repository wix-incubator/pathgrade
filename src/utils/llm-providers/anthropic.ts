import type {
    LLMProvider,
    LLMCallOptions,
    LLMCallResult,
    CallWithToolsOptions,
    CallWithToolsResult,
    ToolUseBlock,
    ToolUseMessage,
} from '../llm-types.js';

interface AnthropicResponse {
    content?: Array<
        | { type?: 'text'; text?: string }
        | { type?: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
    >;
    stop_reason?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

function getApiKey(env?: Record<string, string>): string | undefined {
    return env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
}

function resolveBaseUrl(env?: Record<string, string>): string {
    return env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
}

function buildHeaders(apiKey: string, useCache: boolean): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };
    if (useCache) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }
    return headers;
}

function sumInputTokens(usage?: AnthropicResponse['usage']): number {
    return (usage?.input_tokens ?? 0)
        + (usage?.cache_creation_input_tokens ?? 0)
        + (usage?.cache_read_input_tokens ?? 0);
}

async function postAnthropic(
    apiKey: string,
    useCache: boolean,
    body: Record<string, unknown>,
    env?: Record<string, string>,
): Promise<AnthropicResponse> {
    const response = await fetch(`${resolveBaseUrl(env)}/v1/messages`, {
        method: 'POST',
        headers: buildHeaders(apiKey, useCache),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Anthropic API error (${response.status}): ${errBody.slice(0, 300)}`);
    }
    return await response.json() as AnthropicResponse;
}

export const anthropicProvider: LLMProvider = {
    name: 'anthropic',

    async isAvailable(env?: Record<string, string>): Promise<boolean> {
        return !!getApiKey(env);
    },

    supportsModel(model: string): boolean {
        return model.trim().toLowerCase().startsWith('claude');
    },

    async call(prompt: string, opts: LLMCallOptions): Promise<LLMCallResult> {
        const apiKey = getApiKey(opts.env);
        if (!apiKey) {
            throw new Error('No ANTHROPIC_API_KEY available');
        }

        const model = opts.model || 'claude-sonnet-4-20250514';
        const temperature = opts.temperature ?? 0;
        const useCache = opts.cacheControl ?? false;

        const content = useCache
            ? [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]
            : prompt;

        try {
            const data = await postAnthropic(apiKey, useCache, {
                model,
                max_tokens: 4096,
                temperature,
                messages: [{ role: 'user', content }],
            }, opts.env);

            const inputTokens = sumInputTokens(data?.usage);
            const firstText = data?.content?.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined;
            return {
                text: firstText?.text || '',
                inputTokens: inputTokens || undefined,
                outputTokens: data?.usage?.output_tokens,
                provider: 'anthropic',
                model,
            };
        } catch (error) {
            throw new Error(`Anthropic API call failed`, { cause: error });
        }
    },

    async callWithTools(
        messages: ToolUseMessage[],
        opts: CallWithToolsOptions,
    ): Promise<CallWithToolsResult> {
        const apiKey = getApiKey(opts.env);
        if (!apiKey) {
            throw new Error('No ANTHROPIC_API_KEY available');
        }

        const model = opts.model || 'claude-sonnet-4-20250514';
        const temperature = opts.temperature ?? 0;
        const maxTokens = opts.maxTokens ?? 4096;
        const useCache = opts.cacheControl === true;

        // Tool schemas: only the last gets cache_control, serving as a cache
        // breakpoint covering the entire (stable) schema block.
        const tools = useCache && opts.tools.length > 0
            ? opts.tools.map((t, i) =>
                i === opts.tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
            )
            : opts.tools;

        const body: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            temperature,
            messages,
            tools,
        };
        if (opts.system) {
            body.system = useCache
                ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
                : opts.system;
        }

        const data = await postAnthropic(apiKey, useCache, body, opts.env);
        const inputTokens = sumInputTokens(data?.usage);
        const blocks: ToolUseBlock[] = [];
        let text = '';
        for (const block of data?.content ?? []) {
            if ((block as { type?: string }).type === 'tool_use') {
                const b = block as { id?: string; name?: string; input?: Record<string, unknown> };
                if (b.id && b.name) {
                    blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
                }
            } else if ((block as { type?: string }).type === 'text') {
                text += (block as { text?: string }).text ?? '';
            }
        }

        if (blocks.length > 0) {
            return {
                kind: 'tool_use',
                blocks,
                text: text || undefined,
                inputTokens: inputTokens || undefined,
                outputTokens: data?.usage?.output_tokens,
            };
        }
        return {
            kind: 'final',
            text,
            inputTokens: inputTokens || undefined,
            outputTokens: data?.usage?.output_tokens,
        };
    },
};
