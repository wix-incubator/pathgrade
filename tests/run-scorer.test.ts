import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';

import type { CallWithToolsResult, ToolCapableLLMPort } from '../src/utils/llm-types.js';

import { runScorer } from '../src/sdk/run-scorer.js';
import { buildRunSnapshot, evaluate } from '../src/sdk/index.js';
import type {
    CheckScorer,
    JudgeScorer,
    ScoreScorer,
    ScorerContext,
    ToolUsageScorer,
} from '../src/sdk/types.js';
import type { CommandResult, LogEntry } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';

function makeCtx(overrides: Partial<ScorerContext> = {}): ScorerContext {
    return {
        workspace: os.tmpdir(),
        log: [],
        transcript: '[User] hi\n\n[Agent] done',
        toolEvents: [],
        runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        artifacts: { list: () => [], read: async () => '', latest: async () => null },
        ...overrides,
    };
}

describe('runScorer', () => {
    it('runs a check scorer without requiring an LLM', async () => {
        const scorer: CheckScorer = {
            type: 'check',
            name: 'has-file',
            weight: 2,
            fn: () => true,
        };
        const entry = await runScorer(scorer, makeCtx());
        expect(entry).toMatchObject({
            name: 'has-file',
            type: 'check',
            score: 1,
            weight: 2,
            status: 'ok',
        });
    });

    it('runs a score scorer (numeric return) clamped to [0, 1]', async () => {
        const scorer: ScoreScorer = {
            type: 'score',
            name: 'richness',
            weight: 1,
            fn: () => 1.7,
        };
        const entry = await runScorer(scorer, makeCtx());
        expect(entry).toMatchObject({ name: 'richness', type: 'score', score: 1, status: 'ok' });
    });

    it('runs a toolUsage scorer against ctx.toolEvents', async () => {
        const events: ToolEvent[] = [
            { action: 'read_file', provider: 'claude', providerToolName: 'read_file', arguments: { path: 'a.ts' }, summary: '', confidence: 'high', rawSnippet: '' },
            { action: 'read_file', provider: 'claude', providerToolName: 'read_file', arguments: { path: 'b.ts' }, summary: '', confidence: 'high', rawSnippet: '' },
        ];
        const scorer: ToolUsageScorer = {
            type: 'tool_usage',
            name: 'reads-files',
            weight: 1,
            expectations: [
                { action: 'read_file', min: 2 },
                { action: 'write_file', min: 1 },
            ],
        };
        const entry = await runScorer(scorer, makeCtx({ toolEvents: events }));
        expect(entry).toMatchObject({
            name: 'reads-files',
            type: 'tool_usage',
            status: 'ok',
            score: 0.5,
        });
    });

    it('throws the exact RFC 004 error text when opts.llm is missing for a judge scorer', async () => {
        const scorer: JudgeScorer = {
            type: 'judge',
            name: 'quality',
            weight: 1,
            rubric: 'Rate it',
        };
        await expect(runScorer(scorer, makeCtx())).rejects.toThrow(
            'runScorer() requires opts.llm for judge scorers. Pass an LLM provider: runScorer(scorer, ctx, { llm: anthropicProvider })',
        );
    });

    it('runs a plain judge via the pipeline when opts.llm is provided', async () => {
        const mockCall = vi.fn().mockResolvedValue({
            text: '{"score": 0.77, "reasoning": "solid"}',
            provider: 'anthropic',
            model: 'test',
            inputTokens: 5,
            outputTokens: 3,
        });
        const scorer: JudgeScorer = {
            type: 'judge',
            name: 'plain-judge',
            weight: 1,
            rubric: 'Rate it',
        };

        const entry = await runScorer(scorer, makeCtx(), { llm: { call: mockCall } });

        expect(mockCall).toHaveBeenCalledOnce();
        expect(entry).toMatchObject({
            name: 'plain-judge',
            type: 'judge',
            status: 'ok',
            score: 0.77,
        });
    });

    describe('equivalence with evaluate.fromSnapshot', () => {
        const tempPaths: string[] = [];
        afterEach(async () => {
            for (const p of tempPaths) await fs.remove(p).catch(() => {});
            tempPaths.length = 0;
        });

        async function buildSnapshotWith(toolEvents: ToolEvent[]): Promise<{ snapshotPath: string; workspace: string }> {
            const workspace = path.join(os.tmpdir(), `pg-equiv-${Math.random().toString(36).slice(2)}`);
            tempPaths.push(workspace);
            await fs.ensureDir(workspace);
            const snapshotPath = path.join(workspace, 'run-snapshot.json');
            const log: LogEntry[] = toolEvents.map((event, i) => ({
                type: 'tool_event' as const,
                timestamp: `2026-04-07T12:00:0${i}.000Z`,
                tool_event: event,
            }));
            await fs.writeJSON(snapshotPath, buildRunSnapshot({
                agent: 'codex',
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'agent', content: 'done' },
                ],
                log,
                conversationResult: {
                    turns: 1,
                    completionReason: 'until',
                    turnTimings: [{ turn: 1, durationMs: 10 }],
                    stepResults: [],
                },
                workspace,
            }));
            return { snapshotPath, workspace };
        }

        it('check scorer: runScorer score equals evaluate.fromSnapshot score', async () => {
            const scorer: CheckScorer = {
                type: 'check',
                name: 'has-transcript',
                weight: 2,
                fn: (ctx) => ctx.transcript.includes('done'),
            };
            const { snapshotPath } = await buildSnapshotWith([]);
            const viaEvaluate = await evaluate.fromSnapshot(snapshotPath, [scorer]);
            const standalone = await runScorer(scorer, {
                ...makeCtx({ transcript: '[User]\nhi\n\n[Agent]\ndone' }),
            });
            expect(standalone.score).toBe(viaEvaluate.scorers[0].score);
            expect(standalone.status).toBe(viaEvaluate.scorers[0].status);
            expect(standalone.type).toBe(viaEvaluate.scorers[0].type);
        });

        it('score scorer: runScorer score equals evaluate.fromSnapshot score', async () => {
            const scorer: ScoreScorer = {
                type: 'score',
                name: 'length-ratio',
                weight: 1,
                fn: (ctx) => ctx.transcript.length / 100,
            };
            const { snapshotPath } = await buildSnapshotWith([]);
            const viaEvaluate = await evaluate.fromSnapshot(snapshotPath, [scorer]);
            const standalone = await runScorer(scorer, makeCtx({ transcript: '[User]\nhi\n\n[Agent]\ndone' }));
            expect(standalone.score).toBe(viaEvaluate.scorers[0].score);
            expect(standalone.status).toBe(viaEvaluate.scorers[0].status);
        });

        it('tool_usage scorer: runScorer score equals evaluate.fromSnapshot score', async () => {
            const events: ToolEvent[] = [
                { action: 'read_file', provider: 'claude', providerToolName: 'read_file', arguments: { path: 'a.ts' }, summary: '', confidence: 'high', rawSnippet: '' },
                { action: 'read_file', provider: 'claude', providerToolName: 'read_file', arguments: { path: 'b.ts' }, summary: '', confidence: 'high', rawSnippet: '' },
            ];
            const scorer: ToolUsageScorer = {
                type: 'tool_usage',
                name: 'reads',
                weight: 1,
                expectations: [{ action: 'read_file', min: 2 }],
            };
            const { snapshotPath } = await buildSnapshotWith(events);
            const viaEvaluate = await evaluate.fromSnapshot(snapshotPath, [scorer]);
            const standalone = await runScorer(scorer, makeCtx({ toolEvents: events }));
            expect(standalone.score).toBe(viaEvaluate.scorers[0].score);
            expect(standalone.status).toBe(viaEvaluate.scorers[0].status);
        });
    });

    it('runs a tool-equipped judge via the session without pushing to ctx.log', async () => {
        const scripted: CallWithToolsResult[] = [
            { kind: 'final', text: '```json\n{"score": 0.9, "details": "fine"}\n```', inputTokens: 4, outputTokens: 2 },
        ];
        let i = 0;
        const llm: ToolCapableLLMPort = {
            async call() { throw new Error('unused'); },
            async callWithTools() {
                const next = scripted[i++];
                if (!next) throw new Error('out of responses');
                return next;
            },
        };
        const scorer: JudgeScorer = {
            type: 'judge',
            name: 'tool-judge',
            weight: 1,
            rubric: 'Rate it',
            tools: ['readFile'],
        };
        const ctx = makeCtx();

        const entry = await runScorer(scorer, ctx, { llm });

        expect(entry).toMatchObject({
            name: 'tool-judge',
            type: 'judge',
            status: 'ok',
            score: 0.9,
        });
        expect(ctx.log.filter((e: LogEntry) => e.type === 'judge_tool_call')).toEqual([]);
    });
});
