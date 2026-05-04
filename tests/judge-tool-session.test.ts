import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsExtra from 'fs-extra';
import { runJudgeSession } from '../src/sdk/judge-tool-session.js';
import type { CallWithToolsResult, ToolCapableLLMPort, ToolUseBlock } from '../src/utils/llm-types.js';
import type { JudgeScorer, ScorerContext } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';

function makeCtx(workspace: string): ScorerContext {
    return {
        workspace,
        log: [],
        transcript: '[User] Hi\n\n[Agent] Done',
        toolEvents: [],
        runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        artifacts: { list: () => [], read: async () => '', latest: async () => null },
    };
}

function scripted(results: CallWithToolsResult[]): { llm: ToolCapableLLMPort; calls: unknown[][] } {
    const calls: unknown[][] = [];
    let i = 0;
    const llm: ToolCapableLLMPort = {
        async call() { throw new Error('unused in tool-use tests'); },
        async callWithTools(messages, opts) {
            calls.push([messages, opts]);
            const next = results[i++];
            if (!next) throw new Error(`scripted: no more responses (call ${i})`);
            return next;
        },
    };
    return { llm, calls };
}

function tool(id: string, name: string, input: unknown): ToolUseBlock {
    return { type: 'tool_use', id, name, input: input as Record<string, unknown> };
}

function final(text: string): CallWithToolsResult {
    return { kind: 'final', text, inputTokens: 10, outputTokens: 5 };
}

function toolUse(blocks: ToolUseBlock[], text?: string): CallWithToolsResult {
    return { kind: 'tool_use', blocks, text, inputTokens: 10, outputTokens: 5 };
}

const scorer: JudgeScorer = {
    type: 'judge',
    name: 'spec-quality',
    weight: 1,
    rubric: 'Rate the spec quality',
    tools: ['readFile'],
};

describe('runJudgeSession', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-session-')),
        );
        await fs.writeFile(path.join(workspace, 'spec.md'), '# Spec\n\nFR-1: do a thing');
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    it('single-turn final returns a success SessionOutcome', async () => {
        const { llm } = scripted([final('```json\n{"score": 0.9, "details": "great"}\n```')]);
        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBeNull();
        if (outcome.code === null) {
            expect(outcome.score).toBe(0.9);
            expect(outcome.details).toBe('great');
        }
        expect(outcome.rounds).toBe(1);
        expect(outcome.toolCalls).toEqual([]);
        expect(outcome.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it('multi-turn with readFile reads the actual file and scores based on content', async () => {
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            final('```json\n{"score": 0.85, "details": "FR-1 present"}\n```'),
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });

        expect(outcome.code).toBeNull();
        if (outcome.code === null) expect(outcome.score).toBe(0.85);
        expect(outcome.rounds).toBe(2);
        expect(outcome.toolCalls).toHaveLength(1);
        expect(outcome.toolCalls[0]).toMatchObject({ name: 'readFile', ok: true });
        const secondMessages = calls[1][0] as Array<{ role: string; content: unknown }>;
        const last = secondMessages[secondMessages.length - 1];
        expect(last.role).toBe('user');
        expect(JSON.stringify(last.content)).toContain('FR-1: do a thing');
    });

    it('executes parallel tool calls in a single turn', async () => {
        const { llm } = scripted([
            toolUse([
                tool('t1', 'readFile', { path: 'a.txt' }),
                tool('t2', 'readFile', { path: 'b.txt' }),
            ]),
            final('```json\n{"score": 0.8, "details": "both"}\n```'),
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm }, {
            toolExecutor: async (name, input) => `content of ${(input as { path?: string }).path}`,
        });
        expect(outcome.toolCalls).toHaveLength(2);
        expect(outcome.toolCalls.map((c) => c.name)).toEqual(['readFile', 'readFile']);
    });

    it('max-rounds termination produces max_rounds code with actionable details', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
        ]);

        const outcome = await runJudgeSession(
            { scorer, ctx: makeCtx(workspace), llm },
            { maxRounds: 1, toolExecutor: async () => 'ok' },
        );
        expect(outcome.code).toBe('max_rounds');
        expect(outcome.details).toMatch(/maxRounds/);
    });

    it('invalid JSON in final answer produces invalid_score code', async () => {
        const { llm } = scripted([final('not json at all')]);
        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBe('invalid_score');
    });

    it('out-of-range score produces invalid_score code', async () => {
        const { llm } = scripted([final('```json\n{"score": 42, "details": "wild"}\n```')]);
        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBe('invalid_score');
    });

    it('empty final text produces llm_refused code', async () => {
        const { llm } = scripted([final('')]);
        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBe('llm_refused');
    });

    it('response with both text and tool_use is treated as tool_use (not final)', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })], 'I will read the file first'),
            final('```json\n{"score": 0.7, "details": "ok"}\n```'),
        ]);

        const outcome = await runJudgeSession(
            { scorer, ctx: makeCtx(workspace), llm },
            { toolExecutor: async () => 'stub' },
        );
        expect(outcome.rounds).toBe(2);
        expect(outcome.code).toBeNull();
    });

    it('tool name outside allowlist hard-stops loop', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'runCommand', { cmd: 'rm -rf /' })]),
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBe('tool_error_unrecoverable');
        expect(outcome.details).toMatch(/runCommand|allowlist|not allowed/i);
    });

    it('invalid tool arguments are returned as is_error results; loop continues', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { notPath: 'hmm' })]),
            final('```json\n{"score": 0.1, "details": "recovered"}\n```'),
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBeNull();
        if (outcome.code === null) expect(outcome.score).toBe(0.1);
        expect(outcome.toolCalls[0].ok).toBe(false);
    });

    it('Promise.allSettled: one tool rejection does not drop peer results', async () => {
        await fs.writeFile(path.join(workspace, 'ok.txt'), 'here');
        const { llm } = scripted([
            toolUse([
                tool('bad', 'readFile', { path: '../escape.txt' }),
                tool('good', 'readFile', { path: 'ok.txt' }),
            ]),
            final('```json\n{"score": 0.5, "details": "mixed"}\n```'),
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.toolCalls).toHaveLength(2);
        const goodCall = outcome.toolCalls.find((c) => (c.input as { path?: string }).path === 'ok.txt');
        expect(goodCall?.ok).toBe(true);
    });

    it('per-tool-call timeout is enforced without stopping the loop', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            final('```json\n{"score": 0.3, "details": "timed out"}\n```'),
        ]);

        const outcome = await runJudgeSession(
            { scorer, ctx: makeCtx(workspace), llm },
            {
                toolTimeoutMs: 10,
                toolExecutor: async () => {
                    await new Promise((r) => setTimeout(r, 500));
                    return 'never';
                },
            },
        );

        expect(outcome.code).toBeNull();
        expect(outcome.toolCalls[0].ok).toBe(false);
        expect(outcome.toolCalls[0].errorMessage).toMatch(/timeout|timed out/i);
    });

    it('fails fast with tool_error_unrecoverable when workspace does not exist', async () => {
        const missingCtx = makeCtx('/nonexistent/path/pathgrade-test-missing');
        const { llm } = scripted([final('unused')]);
        const outcome = await runJudgeSession({ scorer, ctx: missingCtx, llm });
        expect(outcome.code).toBe('tool_error_unrecoverable');
        expect(outcome.details).toMatch(/workspace/i);
    });

    it('accumulates token usage from every turn', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            { ...final('```json\n{"score": 1, "details": "!"}\n```'), inputTokens: 100, outputTokens: 50 },
        ]);

        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.tokenUsage.inputTokens).toBe(10 + 100);
        expect(outcome.tokenUsage.outputTokens).toBe(5 + 50);
    });

    it('dispatches listDir through the default registry and returns directory entries', async () => {
        await fs.mkdir(path.join(workspace, 'sub'));
        await fs.writeFile(path.join(workspace, 'sub', 'n.txt'), 'data');
        const scorerAll: JudgeScorer = { ...scorer, tools: ['readFile', 'listDir'] };
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'listDir', { path: 'sub' })]),
            final('```json\n{"score": 0.6, "details": "listed"}\n```'),
        ]);
        const outcome = await runJudgeSession({ scorer: scorerAll, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBeNull();
        expect(outcome.toolCalls[0].ok).toBe(true);
        const toolResultMessage = calls[1][0] as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(toolResultMessage.at(-1)!.content)).toContain('n.txt');
    });

    it('dispatches grep through the default registry and returns path:line:text matches', async () => {
        await fs.writeFile(path.join(workspace, 'a.md'), 'first\nhit here\nthird');
        const scorerAll: JudgeScorer = { ...scorer, tools: ['readFile', 'grep'] };
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'grep', { pattern: 'hit' })]),
            final('```json\n{"score": 0.7, "details": "found"}\n```'),
        ]);
        const outcome = await runJudgeSession({ scorer: scorerAll, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBeNull();
        const toolResultMessage = calls[1][0] as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(toolResultMessage.at(-1)!.content)).toContain('a.md:2:hit here');
    });

    it('dispatches getToolEvents with optional filter', async () => {
        const scorerAll: JudgeScorer = {
            ...scorer,
            tools: ['readFile', 'getToolEvents'],
            includeToolEvents: true,
        };
        const ctx = makeCtx(workspace);
        ctx.toolEvents = [
            { action: 'read_file', providerToolName: 'Read', provider: 'claude', turnNumber: 1 } as never,
            { action: 'run_shell', providerToolName: 'Bash', provider: 'claude', turnNumber: 2 } as never,
        ];
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'getToolEvents', { actionFilter: 'read' })]),
            final('```json\n{"score": 0.5, "details": "ok"}\n```'),
        ]);
        const outcome = await runJudgeSession({ scorer: scorerAll, ctx, llm });
        expect(outcome.code).toBeNull();
        const toolResultMessage = calls[1][0] as Array<{ role: string; content: unknown }>;
        const body = JSON.stringify(toolResultMessage.at(-1)!.content);
        expect(body).toContain('read_file');
        expect(body).not.toContain('run_shell');
    });

    it('forwards cacheControl=true to callWithTools for every turn', async () => {
        const scorerCached: JudgeScorer = { ...scorer, cacheControl: true };
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            final('```json\n{"score": 0.9, "details": "ok"}\n```'),
        ]);

        await runJudgeSession({ scorer: scorerCached, ctx: makeCtx(workspace), llm });

        expect(calls).toHaveLength(2);
        for (const [, opts] of calls) {
            const o = opts as { cacheControl?: boolean };
            expect(o.cacheControl).toBe(true);
        }
    });

    it('forwards cacheControl=false when scorer opts out', async () => {
        const scorerUncached: JudgeScorer = { ...scorer, cacheControl: false };
        const { llm, calls } = scripted([
            final('```json\n{"score": 0.4, "details": "nope"}\n```'),
        ]);

        await runJudgeSession({ scorer: scorerUncached, ctx: makeCtx(workspace), llm });
        const opts = calls[0][1] as { cacheControl?: boolean };
        expect(opts.cacheControl).toBe(false);
    });

    it('provider without callWithTools produces provider_not_supported code', async () => {
        const llmWithoutTools = { call: async () => { throw new Error('no'); } };
        const outcome = await runJudgeSession({
            scorer,
            ctx: makeCtx(workspace),
            llm: llmWithoutTools as unknown as ToolCapableLLMPort,
        });
        expect(outcome.code).toBe('provider_not_supported');
        expect(outcome.details).toMatch(/callWithTools|Anthropic|ANTHROPIC_API_KEY/i);
    });

    it('emits judge_tool_call LogEntry to ctx.log for each tool invocation', async () => {
        const { llm } = scripted([
            toolUse([
                tool('t1', 'readFile', { path: 'spec.md' }),
                tool('t2', 'readFile', { path: 'spec.md' }),
            ]),
            final('```json\n{"score": 0.5, "details": "ok"}\n```'),
        ]);
        const ctx = makeCtx(workspace);
        await runJudgeSession({ scorer, ctx, llm });
        const entries = ctx.log.filter((e) => e.type === 'judge_tool_call');
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            type: 'judge_tool_call',
            judge_tool_call: { name: 'readFile', ok: true, judge_name: 'spec-quality' },
        });
        expect(entries[0].judge_tool_call?.bytes).toBeGreaterThan(0);
    });

    it('HTTP error from callWithTools surfaces as tool_error_unrecoverable', async () => {
        const llm: ToolCapableLLMPort = {
            call: async () => { throw new Error('unused'); },
            callWithTools: async () => {
                throw new Error('Anthropic API error (429): rate_limit_error');
            },
        };
        const outcome = await runJudgeSession({ scorer, ctx: makeCtx(workspace), llm });
        expect(outcome.code).toBe('tool_error_unrecoverable');
        expect(outcome.details).toMatch(/429|rate_limit/);
    });

    it('options.registry overrides the default tool dispatch', async () => {
        const calls: string[] = [];
        const customRegistry = new Map<string, import('../src/sdk/judge-tools.js').RegisteredTool>([
            ['readFile', {
                schema: {
                    name: 'readFile',
                    description: 'custom',
                    input_schema: { type: 'object', properties: {}, required: [] },
                },
                async run(input) {
                    calls.push(JSON.stringify(input));
                    return 'from-custom-registry';
                },
            }],
        ]);
        const { llm, calls: llmCalls } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            final('```json\n{"score": 0.55, "details": "ok"}\n```'),
        ]);
        const outcome = await runJudgeSession(
            { scorer, ctx: makeCtx(workspace), llm },
            { registry: customRegistry },
        );
        expect(outcome.code).toBeNull();
        expect(calls).toEqual(['{"path":"spec.md"}']);
        const secondMessages = llmCalls[1][0] as Array<{ role: string; content: unknown }>;
        expect(JSON.stringify(secondMessages.at(-1)!.content)).toContain('from-custom-registry');
    });

    it('emitLogs:false keeps ctx.log empty while returning logEntries in the outcome', async () => {
        const { llm } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
            final('```json\n{"score": 0.6, "details": "read spec"}\n```'),
        ]);
        const ctx = makeCtx(workspace);

        const outcome = await runJudgeSession(
            { scorer, ctx, llm },
            { emitLogs: false },
        );

        expect(outcome.code).toBeNull();
        expect(ctx.log).toEqual([]);
        expect(outcome.logEntries).toHaveLength(1);
        expect(outcome.logEntries[0]).toMatchObject({
            type: 'judge_tool_call',
            judge_tool_call: { name: 'readFile', ok: true, judge_name: 'spec-quality' },
        });
    });
});
