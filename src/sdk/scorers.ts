import type {
    CheckScorer,
    CodeJudgeToolName,
    ScorerContext,
    JudgeScorer,
    ScoreScorer,
    ScoreResult,
    ToolExpectation,
    ToolUsageScorer,
} from './types.js';

/**
 * Create a check scorer — a boolean gate that passes (1.0) or fails (0.0).
 */
export function check(
    name: string,
    fn: (ctx: ScorerContext) => boolean | Promise<boolean>,
    opts?: { weight?: number },
): CheckScorer {
    return {
        type: 'check',
        name,
        weight: opts?.weight ?? 1,
        fn,
    };
}

/**
 * Create a score scorer — returns a number (0-1) or { score, details } for partial credit.
 */
export function score(
    name: string,
    fn: (ctx: ScorerContext) => number | ScoreResult | Promise<number | ScoreResult>,
    opts?: { weight?: number },
): ScoreScorer {
    return {
        type: 'score',
        name,
        weight: opts?.weight ?? 1,
        fn,
    };
}

/**
 * Create a judge scorer — uses an LLM to evaluate against a rubric.
 * Transcript is auto-included. Tool events opt-in via includeToolEvents.
 *
 * @param opts.input - Additional context to include in the judge prompt alongside
 *   the transcript. Each key becomes a section heading; string values are rendered
 *   as-is, objects are JSON-stringified. Use this to pass file contents, command
 *   output, or other artifacts that the agent produced but may not appear in the
 *   transcript. The judge LLM only sees the conversation transcript by default —
 *   if the agent wrote a file, the judge cannot verify its contents unless you read
 *   the file and pass it here.
 *
 *   @example
 *   // Read the file the agent created and pass it to the judge
 *   const content = await agent.exec('cat output.md');
 *   judge('file quality', {
 *     rubric: 'The output file should contain a valid markdown document...',
 *     input: { 'output.md contents': content.stdout },
 *   })
 *   // Or derive the judge input from scorer context
 *   judge('file quality', {
 *     rubric: 'The output file should contain a valid markdown document...',
 *     input: async (ctx) => ({ 'output.md contents': await ctx.artifacts.read('output.md') }),
 *   })
 */
export function judge(
    name: string,
    opts: {
        rubric: string;
        weight?: number;
        model?: string;
        retry?: boolean | number;
        includeToolEvents?: boolean;
        /** Additional context for the judge. See function docs for usage pattern. */
        input?: import('./types.js').JudgeInput;
        /**
         * Opt-in allowlist of tools the judge LLM may call during a multi-turn
         * tool-use loop. When set to a non-empty array, the judge runs in a
         * tool-use loop against a provider that supports callWithTools. When
         * omitted, behavior is byte-for-byte unchanged.
         */
        tools?: CodeJudgeToolName[];
        /** Cap on LLM calls per tool-use judge; default 10. */
        maxRounds?: number;
        /** Anthropic prompt caching. Default: true when tools is set, unchanged otherwise. */
        cacheControl?: boolean;
    },
): JudgeScorer {
    const tools = opts.tools && opts.tools.length > 0 ? [...opts.tools] : undefined;
    const includeToolEvents = opts.includeToolEvents
        ?? (tools?.includes('getToolEvents') ? true : undefined);
    // When tools is set, default cacheControl to true (mitigates the
    // 10–70× input-token inflation measured in the spike). Explicit
    // false opts out; explicit true is a no-op.
    const cacheControl = opts.cacheControl ?? (tools ? true : undefined);
    return {
        type: 'judge',
        name,
        weight: opts.weight ?? 1,
        rubric: opts.rubric,
        model: opts.model,
        retry: opts.retry,
        includeToolEvents,
        input: opts.input,
        tools,
        maxRounds: opts.maxRounds,
        cacheControl,
    };
}

/**
 * Create a tool usage scorer — matches tool events against expectations.
 */
export function toolUsage(
    name: string,
    expectations: ToolExpectation[],
    opts?: { weight?: number },
): ToolUsageScorer {
    return {
        type: 'tool_usage',
        name,
        weight: opts?.weight ?? 1,
        expectations,
    };
}
