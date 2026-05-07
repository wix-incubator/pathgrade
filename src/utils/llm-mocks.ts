import type {
    LLMPort,
    LLMCallOptions,
    LLMCallResult,
    ToolUseMessage,
    ToolUseBlock,
    CallWithToolsOptions,
    CallWithToolsResult,
    TokenUsage,
} from './llm-types.js';

export type MockResponse =
    | string
    | {
        text: string;
        inputTokens?: number;
        outputTokens?: number;
        provider?: 'anthropic' | 'openai' | 'cli';
        model?: string;
    }
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
    }
    | { throws: Error };

export interface CreateMockLLMOptions {
    responses?: MockResponse[];
    /** Returned whenever the queue is empty. Overrides the default "out of responses" error. */
    defaultResponse?: MockResponse;
    /** When set, replaces the queue for `.call()`. Useful for dynamic / side-effecting tests. */
    respond?: (prompt: string, opts?: LLMCallOptions) => MockResponse | Promise<MockResponse>;
}

export interface MockCallRecord {
    prompt: string;
    opts?: LLMCallOptions;
}

export interface MockToolCallRecord {
    messages: ToolUseMessage[];
    opts: CallWithToolsOptions;
}

export interface MockLLM extends LLMPort {
    queueResponse(r: MockResponse): void;
    clearCalls(): void;
    readonly calls: readonly MockCallRecord[];
    readonly toolCalls: readonly MockToolCallRecord[];
}

function isToolResponse(r: MockResponse): r is Extract<MockResponse, { kind: 'tool_use' | 'final' }> {
    return typeof r === 'object' && 'kind' in r;
}

function isThrowResponse(r: MockResponse): r is { throws: Error } {
    return typeof r === 'object' && 'throws' in r;
}

export function createMockLLM(opts: CreateMockLLMOptions = {}): MockLLM {
    const queue: MockResponse[] = [...(opts.responses ?? [])];
    const calls: MockCallRecord[] = [];
    const toolCalls: MockToolCallRecord[] = [];
    const defaultResponse = opts.defaultResponse;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let callCount = 0;

    const take = (): MockResponse => {
        callCount++;
        const r = queue.shift();
        if (r !== undefined) return r;
        if (defaultResponse !== undefined) return defaultResponse;
        throw new Error(`createMockLLM: out of responses (call #${callCount})`);
    };

    const port: MockLLM = {
        get tokenUsage(): TokenUsage {
            return { inputTokens, outputTokens };
        },
        get costUsd(): number {
            return costUsd;
        },
        get supportsToolUse(): boolean {
            return true;
        },
        get lastProvider(): string | undefined {
            return 'mock';
        },
        addTokens(input: number, output: number) {
            inputTokens += input;
            outputTokens += output;
        },
        addCost(usd: number) {
            if (!Number.isFinite(usd) || usd < 0) return;
            costUsd += usd;
        },
        async measure<T>(fn: () => Promise<T>): Promise<{ result: T; tokens: TokenUsage; costUsd: number }> {
            const inBefore = inputTokens;
            const outBefore = outputTokens;
            const costBefore = costUsd;
            const result = await fn();
            return {
                result,
                tokens: {
                    inputTokens: inputTokens - inBefore,
                    outputTokens: outputTokens - outBefore,
                },
                costUsd: costUsd - costBefore,
            };
        },
        async call(prompt: string, callOpts?: LLMCallOptions): Promise<LLMCallResult> {
            calls.push({ prompt, opts: callOpts });
            const r = opts.respond ? await opts.respond(prompt, callOpts) : take();
            if (isThrowResponse(r)) throw r.throws;
            if (isToolResponse(r)) {
                throw new Error(
                    `createMockLLM: call() got a tool-use response (kind='${r.kind}') — expected a plain call response`,
                );
            }
            const body = typeof r === 'string' ? { text: r } : r;
            inputTokens += body.inputTokens ?? 0;
            outputTokens += body.outputTokens ?? 0;
            return {
                text: body.text,
                inputTokens: body.inputTokens,
                outputTokens: body.outputTokens,
                provider: body.provider ?? 'anthropic',
                model: body.model ?? 'mock',
            };
        },
        async callWithTools(
            messages: ToolUseMessage[],
            callOpts: CallWithToolsOptions,
        ): Promise<CallWithToolsResult> {
            toolCalls.push({ messages, opts: callOpts });
            const r = take();
            if (isThrowResponse(r)) throw r.throws;
            if (!isToolResponse(r)) {
                throw new Error(
                    'createMockLLM: callWithTools() expected a response with kind=\'tool_use\' or kind=\'final\'',
                );
            }
            inputTokens += r.inputTokens ?? 0;
            outputTokens += r.outputTokens ?? 0;
            return r as CallWithToolsResult;
        },
        queueResponse(r: MockResponse) {
            queue.push(r);
        },
        clearCalls() {
            calls.length = 0;
            toolCalls.length = 0;
            callCount = 0;
        },
        get calls(): readonly MockCallRecord[] {
            return calls;
        },
        get toolCalls(): readonly MockToolCallRecord[] {
            return toolCalls;
        },
    };
    return port;
}
