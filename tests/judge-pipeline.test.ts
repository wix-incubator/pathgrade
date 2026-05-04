import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import { runJudgePipeline } from '../src/sdk/judge-pipeline.js';
import type { JudgeScorer, ScorerContext } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';

function makeCtx(transcript = '[User]\nDo the thing\n\n[Agent]\nDone'): ScorerContext {
    return {
        workspace: os.tmpdir(),
        log: [],
        transcript,
        toolEvents: [],
        runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        artifacts: {
            list: () => ['artifacts/discovery/report.md'],
            read: async () => 'artifact body',
            latest: async () => ({ path: 'artifacts/discovery/report.md', content: 'artifact body' }),
        },
    };
}

describe('runJudgePipeline', () => {
    it('uses opts.llm instead of runtime LLM', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: '{"score": 0.9, "reasoning": "great"}',
            provider: 'anthropic',
            model: 'test',
            inputTokens: 100,
            outputTokens: 20,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).toHaveBeenCalledOnce();
        expect(result[0].score).toBe(0.9);
    });

    it('returns empty results for zero judges', async () => {
        const mockCall = vi.fn();
        const result = await runJudgePipeline([], makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).not.toHaveBeenCalled();
        expect(result).toHaveLength(0);
    });

    it('batches same-model judges into single LLM call', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: JSON.stringify([
                { scorer_name: 'a', score: 0.9, reasoning: 'good' },
                { scorer_name: 'b', score: 0.8, reasoning: 'ok' },
            ]),
            provider: 'anthropic',
            model: 'test',
            inputTokens: 500,
            outputTokens: 100,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'a', weight: 1, rubric: 'Rate A' },
            { type: 'judge', name: 'b', weight: 1, rubric: 'Rate B' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).toHaveBeenCalledOnce();
        expect(result).toHaveLength(2);
        expect(result[0].score).toBe(0.9);
        expect(result[1].score).toBe(0.8);
    });

    it('runs judges with different models individually', async () => {
        const mockCall = vi.fn()
            .mockResolvedValueOnce({
                text: '{"score": 0.9, "reasoning": "good"}',
                provider: 'anthropic', model: 'test',
                inputTokens: 100, outputTokens: 20,
            })
            .mockResolvedValueOnce({
                text: '{"score": 0.7, "reasoning": "ok"}',
                provider: 'anthropic', model: 'test',
                inputTokens: 200, outputTokens: 30,
            });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'a', weight: 1, rubric: 'Rate A', model: 'model-1' },
            { type: 'judge', name: 'b', weight: 1, rubric: 'Rate B', model: 'model-2' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).toHaveBeenCalledTimes(2);
        expect(result[0].score).toBe(0.9);
        expect(result[1].score).toBe(0.7);
    });

    it('falls back to individual calls when batch parse fails', async () => {
        const mockCall = vi.fn()
            .mockResolvedValueOnce({
                text: 'unparseable garbage',
                provider: 'anthropic', model: 'test',
            })
            .mockResolvedValueOnce({
                text: '{"score": 0.9, "reasoning": "good"}',
                provider: 'anthropic', model: 'test',
                inputTokens: 100, outputTokens: 20,
            })
            .mockResolvedValueOnce({
                text: '{"score": 0.8, "reasoning": "ok"}',
                provider: 'anthropic', model: 'test',
                inputTokens: 100, outputTokens: 20,
            });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'a', weight: 1, rubric: 'Rate A' },
            { type: 'judge', name: 'b', weight: 1, rubric: 'Rate B' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        // 1 batch attempt + 2 fallbacks
        expect(mockCall).toHaveBeenCalledTimes(3);
        expect(result[0].score).toBe(0.9);
        expect(result[1].score).toBe(0.8);
    });

    it('LLM error yields score 0 without throwing', async () => {
        const mockCall = vi.fn().mockRejectedValue(new Error('LLM down'));

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'failing', weight: 1, rubric: 'Rate it' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(result[0].score).toBe(0);
        expect(result[0].status).toBe('error');
        expect(result[0].details).toContain('LLM down');
    });

    it('does not retry judge calls by default', async () => {
        const mockCall = vi.fn().mockRejectedValue(new Error('temporary outage'));

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'default-no-retry', weight: 1, rubric: 'Rate it' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).toHaveBeenCalledTimes(1);
        expect(result[0]).toEqual(expect.objectContaining({
            status: 'error',
            details: 'temporary outage',
        }));
    });

    it('retries once when retry is true and returns the successful result', async () => {
        vi.useFakeTimers();
        const mockCall = vi.fn()
            .mockRejectedValueOnce(new Error('temporary outage'))
            .mockResolvedValueOnce({
                text: '{"score": 0.88, "reasoning": "recovered"}',
                provider: 'anthropic',
                model: 'test',
            });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'retry-once', weight: 1, rubric: 'Rate it', retry: true },
        ];

        const resultPromise = runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(mockCall).toHaveBeenCalledTimes(2);
        expect(result[0]).toEqual(expect.objectContaining({
            status: 'ok',
            score: 0.88,
            details: 'recovered',
        }));
        vi.useRealTimers();
    });

    it('stops after the configured retry count and returns an errored result', async () => {
        vi.useFakeTimers();
        const mockCall = vi.fn().mockRejectedValue(new Error('still down'));

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'retry-twice', weight: 1, rubric: 'Rate it', retry: 2 },
        ];

        const resultPromise = runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(mockCall).toHaveBeenCalledTimes(3);
        expect(result[0]).toEqual(expect.objectContaining({
            status: 'error',
            details: 'still down',
            score: 0,
        }));
        vi.useRealTimers();
    });

    it('passes cacheControl: true to LLM calls', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: '{"score": 0.5, "reasoning": "mid"}',
            provider: 'anthropic', model: 'test',
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'x', weight: 1, rubric: 'Rate', model: 'claude-test' },
        ];

        await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall.mock.calls[0][1]).toEqual(
            expect.objectContaining({ cacheControl: true, model: 'claude-test' }),
        );
    });

    it('batched prompt includes tool events when any judge opts in', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: JSON.stringify([
                { scorer_name: 'a', score: 0.9, reasoning: 'good' },
                { scorer_name: 'b', score: 0.8, reasoning: 'ok' },
            ]),
            provider: 'anthropic',
            model: 'test',
        });

        const ctx = makeCtx();
        ctx.toolEvents = [
            { action: 'read', providerToolName: 'Read', provider: 'claude', turnNumber: 1 } as never,
        ];

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'a', weight: 1, rubric: 'Rate A', includeToolEvents: true },
            { type: 'judge', name: 'b', weight: 1, rubric: 'Rate B' },
        ];

        await runJudgePipeline(judges, ctx, { llm: { call: mockCall } });

        const prompt = mockCall.mock.calls[0][0] as string;
        expect(prompt).toContain('## Tool Events');
        expect(prompt).toContain('turn 1: read via Read (claude)');
    });

    it('batched prompt includes per-rubric input fields', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: JSON.stringify([
                { scorer_name: 'a', score: 0.9, reasoning: 'good' },
                { scorer_name: 'b', score: 0.8, reasoning: 'ok' },
            ]),
            provider: 'anthropic',
            model: 'test',
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'a', weight: 1, rubric: 'Rate A', input: { 'Expected Output': 'hello world' } },
            { type: 'judge', name: 'b', weight: 1, rubric: 'Rate B' },
        ];

        await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        const prompt = mockCall.mock.calls[0][0] as string;
        expect(prompt).toContain('#### Expected Output');
        expect(prompt).toContain('hello world');
    });

    it('resolves dynamic judge input from scorer context', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: '{"score": 1, "reasoning": "used artifact input"}',
            provider: 'anthropic',
            model: 'test',
        });

        const judges: JudgeScorer[] = [
            {
                type: 'judge',
                name: 'quality',
                weight: 1,
                rubric: 'Rate quality',
                input: async (ctx) => ({
                    'Latest Artifact': (await ctx.artifacts.latest())?.content,
                    'Touched Paths': ctx.artifacts.list().join(', '),
                }),
            },
        ];

        await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        const prompt = mockCall.mock.calls[0][0] as string;
        expect(prompt).toContain('## Latest Artifact');
        expect(prompt).toContain('artifact body');
        expect(prompt).toContain('## Touched Paths');
        expect(prompt).toContain('artifacts/discovery/report.md');
    });

    it('tool-using judges bypass batching and dispatch to the tool-use runner', async () => {
        // Batch mock: should NOT be called for the tool-using judge.
        const mockCall = vi.fn().mockResolvedValue({
            text: JSON.stringify([
                { scorer_name: 'plain', score: 0.5, reasoning: 'meh' },
            ]),
            provider: 'anthropic',
            model: 'test',
        });
        // Tool-use mock
        const mockCallWithTools = vi.fn().mockResolvedValue({
            kind: 'final',
            text: '```json\n{"score": 0.9, "details": "tool-read"}\n```',
            inputTokens: 20,
            outputTokens: 10,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'tooled', weight: 1, rubric: 'Rate with tools', tools: ['readFile'] },
            { type: 'judge', name: 'plain', weight: 1, rubric: 'Rate plain' },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), {
            llm: { call: mockCall, callWithTools: mockCallWithTools },
        });

        // The tool-use judge should call callWithTools, not call()
        expect(mockCallWithTools).toHaveBeenCalledOnce();
        // The plain judge should use call() (either single-turn runner, not batched with a tooled peer)
        expect(mockCall).toHaveBeenCalled();

        const tooled = result.find((r) => r.name === 'tooled');
        const plain = result.find((r) => r.name === 'plain');
        expect(tooled?.score).toBe(0.9);
        expect(tooled?.status).toBe('ok');
        expect(plain?.score).toBe(0.5);
        expect(plain?.status).toBe('ok');
    });

    it('tool-using judge without callWithTools support produces provider_not_supported error', async () => {
        const mockCall = vi.fn();

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'tooled', weight: 1, rubric: 'rate', tools: ['readFile'] },
        ];

        const result = await runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });

        expect(result[0].status).toBe('error');
        expect(result[0].errorCode).toBe('provider_not_supported');
    });

    it('applies retry logic after batched execution falls back to individual calls', async () => {
        vi.useFakeTimers();
        const mockCall = vi.fn()
            .mockResolvedValueOnce({
                text: 'unparseable garbage',
                provider: 'anthropic',
                model: 'test',
            })
            .mockResolvedValueOnce({
                text: '{"score": 0.91, "reasoning": "steady"}',
                provider: 'anthropic',
                model: 'test',
            })
            .mockRejectedValueOnce(new Error('transient fallback failure'))
            .mockResolvedValueOnce({
                text: '{"score": 0.73, "reasoning": "recovered on retry"}',
                provider: 'anthropic',
                model: 'test',
            });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'steady', weight: 1, rubric: 'Rate A' },
            { type: 'judge', name: 'retry-after-fallback', weight: 1, rubric: 'Rate B', retry: true },
        ];

        const resultPromise = runJudgePipeline(judges, makeCtx(), { llm: { call: mockCall } });
        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(mockCall).toHaveBeenCalledTimes(4);
        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'steady', status: 'ok', score: 0.91 }),
            expect.objectContaining({ name: 'retry-after-fallback', status: 'ok', score: 0.73 }),
        ]));
        vi.useRealTimers();
    });

    it('accepts a single judge (not wrapped in array) and returns a flat array', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: '{"score": 0.55, "reasoning": "solo"}',
            provider: 'anthropic',
            model: 'test',
            inputTokens: 10,
            outputTokens: 5,
        });

        const scorer: JudgeScorer = { type: 'judge', name: 'solo', weight: 1, rubric: 'Rate it' };
        const entries = await runJudgePipeline(scorer, makeCtx(), { llm: { call: mockCall } });

        expect(Array.isArray(entries)).toBe(true);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('solo');
        expect(entries[0].score).toBe(0.55);
    });
});
