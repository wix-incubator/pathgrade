export interface LLMCallOptions {
    model?: string;
    env?: Record<string, string>;
    temperature?: number;
    /** When set, use --json-schema for structured output via CLI. */
    jsonSchema?: string;
    /** When true, enable Anthropic prompt caching via cache_control on content blocks. */
    cacheControl?: boolean;
}

export interface LLMCallResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    provider: 'anthropic' | 'openai' | 'cli';
    model: string;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}

/** Caller-facing type — just call(). */
export interface LLMPort {
    call(prompt: string, opts?: LLMCallOptions): Promise<LLMCallResult>;
    /** Present only on providers that opt in to multi-turn tool use. */
    callWithTools?(messages: ToolUseMessage[], opts: CallWithToolsOptions): Promise<CallWithToolsResult>;
    /** Running total of tokens consumed through this port. Present on clients from createLLMClient. */
    readonly tokenUsage?: TokenUsage;
    /** Add externally-observed tokens (e.g. from agent CLI turns). */
    addTokens?(input: number, output: number): void;
    /** Run `fn` and return its token delta. */
    measure?<T>(fn: () => Promise<T>): Promise<{ result: T; tokens: TokenUsage }>;
    /** Name of the adapter that resolved the last call (e.g. 'anthropic'). */
    readonly lastProvider?: string;
    /** True when this port can dispatch tool use. Type-guard form preferred at call sites. */
    readonly supportsToolUse?: boolean;
}

/** Narrower interface the tool-use runner accepts. */
export interface ToolCapableLLMPort extends LLMPort {
    callWithTools(messages: ToolUseMessage[], opts: CallWithToolsOptions): Promise<CallWithToolsResult>;
}

export interface ToolSchema {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

export interface CallWithToolsOptions extends LLMCallOptions {
    system?: string;
    tools: ToolSchema[];
    maxTokens?: number;
}

export interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface ToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
    is_error?: boolean;
}

export interface TextBlock {
    type: 'text';
    text: string;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock;
export type UserContentBlock = TextBlock | ToolResultBlock;

export interface ToolUseMessage {
    role: 'user' | 'assistant';
    content: string | Array<AssistantContentBlock | UserContentBlock>;
}

export type CallWithToolsResult =
    | {
        kind: 'tool_use';
        blocks: ToolUseBlock[];
        text?: string;
        inputTokens?: number;
        outputTokens?: number;
    }
    | {
        kind: 'final';
        text: string;
        inputTokens?: number;
        outputTokens?: number;
    };

/** Wide implementor-facing type — each provider adapter implements this. */
export interface LLMProviderAdapter {
    name: string;
    isAvailable(env?: Record<string, string>): Promise<boolean>;
    call(prompt: string, opts: LLMCallOptions): Promise<LLMCallResult>;
    callWithTools?(messages: ToolUseMessage[], opts: CallWithToolsOptions): Promise<CallWithToolsResult>;
    supportsModel?(model: string): boolean;
}

/** @deprecated Use `LLMProviderAdapter`. Alias retained only during the RFC 010a migration. */
export type LLMProvider = LLMProviderAdapter;
