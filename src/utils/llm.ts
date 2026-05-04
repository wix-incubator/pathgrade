import type {
    LLMProviderAdapter,
    LLMCallOptions,
    LLMCallResult,
    LLMPort,
    CallWithToolsOptions,
    CallWithToolsResult,
    ToolUseMessage,
    TokenUsage,
} from './llm-types.js';
import { cliProvider } from './llm-providers/cli.js';
import { anthropicProvider } from './llm-providers/anthropic.js';
import { openaiProvider } from './llm-providers/openai.js';

export type { LLMCallOptions, LLMCallResult, LLMPort, LLMProviderAdapter, LLMProvider, TokenUsage } from './llm-types.js';

export interface CreateLLMClientOptions {
    adapters?: LLMProviderAdapter[];
    agent?: string;
    env?: Record<string, string>;
    silent?: boolean;
}

export class ProviderNotSupportedError extends Error {
    readonly name = 'ProviderNotSupportedError';
    readonly adapterName: string;

    constructor(adapterName: string) {
        super(
            `Adapter '${adapterName}' does not implement callWithTools. `
            + 'Use an adapter that supports tool use (e.g., anthropicAdapter when '
            + 'ANTHROPIC_API_KEY is set) or remove tools from this judge.',
        );
        this.adapterName = adapterName;
    }
}

// Re-export provider utilities that callsites depend on
export { isClaudeCliAvailable, isCodexCliAvailable, resetCliCache, extractStructuredOutput, parseCliEnvelope } from './llm-providers/cli.js';

function inferProviderFromModel(model?: string): 'anthropic' | 'openai' | undefined {
    const normalized = model?.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized.startsWith('claude')) return 'anthropic';
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

/**
 * Create an LLM client that tries providers in order.
 *
 * For each call, the client:
 * 1. Filters providers by supportsModel() if a model is specified
 * 2. Checks isAvailable() for each candidate
 * 3. Calls the first available provider
 * 4. On failure, falls through to the next provider if one exists
 */
export function createLLMClient(opts: CreateLLMClientOptions): LLMPort;
export function createLLMClient(providers: LLMProviderAdapter[], agentName?: string): LLMPort;
export function createLLMClient(
    arg: CreateLLMClientOptions | LLMProviderAdapter[],
    legacyAgentName?: string,
): LLMPort {
    const options: CreateLLMClientOptions = Array.isArray(arg)
        ? { adapters: arg, agent: legacyAgentName }
        : arg;
    const providers = options.adapters ?? [];
    const agentName = options.agent;
    const silent = options.silent === true;
    const warnedTransitions = new Set<string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let lastProvider: string | undefined;

    const warnFallthrough = (from: string, to: string, reason: string) => {
        if (silent) return;
        const key = `${from}→${to}`;
        if (warnedTransitions.has(key)) return;
        warnedTransitions.add(key);
        console.warn(`pathgrade: LLM provider fallthrough: ${from} failed (${reason}), using ${to}`);
    };
    const accumulate = (result: { inputTokens?: number; outputTokens?: number }) => {
        inputTokens += result.inputTokens ?? 0;
        outputTokens += result.outputTokens ?? 0;
    };
    const toolCapable = providers.find((p) => typeof p.callWithTools === 'function');
    const port: LLMPort = {
        get tokenUsage(): TokenUsage {
            return { inputTokens, outputTokens };
        },
        get supportsToolUse(): boolean {
            return !!toolCapable;
        },
        get lastProvider(): string | undefined {
            return lastProvider;
        },
        addTokens(input: number, output: number) {
            inputTokens += input;
            outputTokens += output;
        },
        async measure<T>(fn: () => Promise<T>): Promise<{ result: T; tokens: TokenUsage }> {
            const inBefore = inputTokens;
            const outBefore = outputTokens;
            const result = await fn();
            return {
                result,
                tokens: {
                    inputTokens: inputTokens - inBefore,
                    outputTokens: outputTokens - outBefore,
                },
            };
        },
        async call(prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
            const requestedProviderType = inferProviderFromModel(opts.model);

            // Filter to providers that support the requested model
            let candidates = opts.model
                ? providers.filter((p) => !p.supportsModel || p.supportsModel(opts.model!))
                : providers;

            // If model explicitly targets a provider type (e.g., "gpt-4o" → openai),
            // narrow to only providers of that type
            const narrowed = requestedProviderType
                ? candidates.filter((p) => p.name === requestedProviderType)
                : candidates;

            // Try narrowed set first, then fall back to all candidates
            const toTry = narrowed.length > 0 ? narrowed : candidates;

            let lastError: Error | undefined;
            let lastFailed: { name: string; reason: string } | undefined;

            for (const provider of toTry) {
                if (!await provider.isAvailable(opts.env)) continue;

                try {
                    const result = await provider.call(prompt, opts);
                    if (lastFailed) warnFallthrough(lastFailed.name, provider.name, lastFailed.reason);
                    accumulate(result);
                    lastProvider = provider.name;
                    return result;
                } catch (error) {
                    lastError = error as Error;
                    lastFailed = { name: provider.name, reason: lastError.message };
                    // Fall through to next provider
                }
            }

            // If narrowed set failed/was unavailable, fall back to all candidates
            if (toTry !== candidates) {
                for (const provider of candidates) {
                    if (toTry.includes(provider)) continue; // already tried
                    if (!await provider.isAvailable(opts.env)) continue;

                    try {
                        const result = await provider.call(prompt, opts);
                        if (lastFailed) warnFallthrough(lastFailed.name, provider.name, lastFailed.reason);
                        accumulate(result);
                        lastProvider = provider.name;
                        return result;
                    } catch (error) {
                        lastError = error as Error;
                        lastFailed = { name: provider.name, reason: lastError.message };
                    }
                }
            }

            if (lastError) throw lastError;

            if (agentName === 'claude') {
                throw new Error(
                    'Claude CLI not found on PATH. Install with: npm install -g @anthropic-ai/claude-code'
                );
            }
            if (agentName === 'codex') {
                throw new Error(
                    'Codex CLI not found on PATH. Install with: npm install -g @openai/codex'
                );
            }
            if (agentName === 'cursor') {
                throw new Error(
                    'Cursor eval requires a judge LLM; set ANTHROPIC_API_KEY or install Claude CLI, or override the judge model.'
                );
            }
            throw new Error(
                'No LLM backend available. Install Claude CLI (claude.ai) or set ANTHROPIC_API_KEY or OPENAI_API_KEY.'
            );
        },
    };
    if (toolCapable) {
        port.callWithTools = async (
            messages: ToolUseMessage[],
            opts: CallWithToolsOptions,
        ): Promise<CallWithToolsResult> => {
            if (!await toolCapable.isAvailable(opts.env)) {
                throw new Error(
                    'Tool-use judge requires ANTHROPIC_API_KEY; the Anthropic HTTP provider is not available.',
                );
            }
            const result = await toolCapable.callWithTools!(messages, opts);
            accumulate(result);
            lastProvider = toolCapable.name;
            return result;
        };
    }
    return port;
}

const defaultClient = createLLMClient([cliProvider, anthropicProvider, openaiProvider]);

export async function callLLM(prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
    return defaultClient.call(prompt, opts);
}

/**
 * Create an LLM client scoped to the providers that match the given agent.
 *
 * - claude → CLI + Anthropic API (no OpenAI fallthrough)
 * - codex  → OpenAI API
 *
 * If `agentEnv` is provided, it is merged into every LLM call so that
 * the agent's env propagates to persona/judge/summarization calls.
 */
export function createAgentLLM(agentName: string, agentEnv?: Record<string, string>): LLMPort {
    // Tool-using judges need a provider that implements callWithTools.
    // For claude, anthropicProvider is added as a tool-use-capable fallback
    // alongside the CLI. The CLI still wins for plain call() when available.
    // Cursor inherits the Claude chain by design (judge consistency across
    // harnesses — see PRD §"LLM-backend routing"). Cursor evals therefore
    // depend on Claude CLI or ANTHROPIC_API_KEY being available at judge time.
    const baseAdapters = agentName === 'codex'
        ? [openaiProvider]
        : [cliProvider, anthropicProvider];
    const adapters = agentEnv && Object.keys(agentEnv).length > 0
        ? baseAdapters.map<LLMProviderAdapter>((a) => ({
            ...a,
            call: (prompt, opts) => a.call(prompt, { ...opts, env: { ...agentEnv, ...opts.env } }),
            ...(a.callWithTools
                ? { callWithTools: (messages, opts) => a.callWithTools!(messages, { ...opts, env: { ...agentEnv, ...opts.env } }) }
                : {}),
        }))
        : baseAdapters;
    return createLLMClient({ adapters, agent: agentName });
}
