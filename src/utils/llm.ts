import { isClaudeCliAvailable, callClaudeCli } from './cli-llm';

interface AnthropicResponse {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
}

interface OpenAIResponse {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LLMCallOptions {
    model?: string;
    env?: Record<string, string>;
    temperature?: number;
    /** When set, use --json-schema for structured output via CLI. */
    jsonSchema?: string;
}

export interface LLMCallResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    provider: 'anthropic' | 'openai' | 'cli';
    model: string;
}

/** Providers that use API keys (excludes 'cli' which uses OAuth). */
type ApiKeyProvider = 'anthropic' | 'openai';

function getApiKeys(env?: Record<string, string>): Record<ApiKeyProvider, string | undefined> {
    return {
        anthropic: env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
        openai: env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    };
}

function inferProviderFromModel(model?: string): ApiKeyProvider | undefined {
    const normalized = model?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (normalized.startsWith('claude')) {
        return 'anthropic';
    }
    if (
        normalized.startsWith('gpt-')
        || normalized.startsWith('chatgpt-')
        || normalized.startsWith('o1')
        || normalized.startsWith('o3')
        || normalized.startsWith('o4')
    ) {
        return 'openai';
    }
    return undefined;
}

function getDefaultModel(provider: ApiKeyProvider): string {
    switch (provider) {
        case 'anthropic':
            return 'claude-sonnet-4-20250514';
        case 'openai':
            return 'gpt-4o';
    }
}

function getProviderSequence(model: string | undefined, env?: Record<string, string>): ApiKeyProvider[] {
    const keys = getApiKeys(env);
    const requestedProvider = inferProviderFromModel(model);
    if (requestedProvider) {
        if (!keys[requestedProvider]) {
            throw new Error(`No API key available for model "${model}"`);
        }
        return [requestedProvider];
    }

    const fallbackOrder: ApiKeyProvider[] = ['anthropic', 'openai'];
    const availableProviders = fallbackOrder.filter((provider) => !!keys[provider]);
    if (availableProviders.length === 0) {
        throw new Error('No LLM backend available. Install Claude CLI (claude.ai) or set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
    }
    return availableProviders;
}

async function callAnthropic(
    prompt: string,
    apiKey: string,
    model: string,
    temperature: number
): Promise<LLMCallResult> {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
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
            throw new Error(`Anthropic API error (${response.status}): ${errBody.slice(0, 300)}`);
        }

        const data = await response.json() as AnthropicResponse;
        return {
            text: data?.content?.[0]?.text || '',
            inputTokens: data?.usage?.input_tokens,
            outputTokens: data?.usage?.output_tokens,
            provider: 'anthropic',
            model,
        };
    } catch (error) {
        throw new Error(`Anthropic API error: ${error}`);
    }
}

async function callOpenAI(
    prompt: string,
    apiKey: string,
    model: string,
    temperature: number,
    env?: Record<string, string>
): Promise<LLMCallResult> {
    const baseUrl = (env?.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

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
}

export async function callLLM(prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
    const keys = getApiKeys(opts.env);

    // CLI-first: prefer Claude CLI when available, unless a non-Claude
    // model is explicitly requested (e.g., "gpt-4o" needs OPENAI_API_KEY).
    const requestedProvider = inferProviderFromModel(opts.model);
    const needsNonClaudeProvider = requestedProvider && requestedProvider !== 'anthropic';

    if (!needsNonClaudeProvider && await isClaudeCliAvailable()) {
        // Build CLI options — forward model and jsonSchema
        const cliOpts: Record<string, string | undefined> = {};
        if (opts.model) cliOpts.model = opts.model;
        if (opts.jsonSchema) cliOpts.jsonSchema = opts.jsonSchema;

        try {
            const cliResult = await callClaudeCli(prompt, cliOpts);
            return {
                text: cliResult.text,
                provider: 'cli',
                model: cliResult.model,
            };
        } catch (error) {
            const hasApiFallback = requestedProvider
                ? !!keys[requestedProvider]
                : Object.values(keys).some(Boolean);
            if (!hasApiFallback) {
                throw error;
            }
        }
    }

    // Existing API-key path (CI, explicit provider keys)
    const providers = getProviderSequence(opts.model, opts.env);
    const temperature = opts.temperature ?? 0;

    for (const provider of providers) {
        const apiKey = keys[provider];
        if (!apiKey) {
            continue;
        }

        const model = opts.model || getDefaultModel(provider);

        if (provider === 'anthropic') {
            return await callAnthropic(prompt, apiKey, model, temperature);
        }
        return await callOpenAI(prompt, apiKey, model, temperature, opts.env);
    }

    throw new Error(
        'No LLM backend available. Install Claude CLI (claude.ai) or set ANTHROPIC_API_KEY or OPENAI_API_KEY.'
    );
}
