import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CheckScorer, ScoreScorer, JudgeScorer, ToolUsageScorer } from '../src/sdk/types.js';
import type { Agent } from '../src/sdk/types.js';
import type { LogEntry, CommandResult } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';
import { evaluate, EvalScorerError } from '../src/sdk/evaluate.js';
import { setRuntime, resetRuntime } from '../src/sdk/eval-runtime.js';
import { createMockLLM, type MockLLM } from '../src/utils/llm-mocks.js';

const DEFAULT_JUDGE_RESPONSE = {
    text: '{"score": 0.5, "reasoning": "default mock"}',
    provider: 'anthropic' as const,
    model: 'test',
};

let mockLLM: MockLLM;

beforeEach(() => {
    mockLLM = createMockLLM({ defaultResponse: DEFAULT_JUDGE_RESPONSE });
    setRuntime({ llm: mockLLM });
});

afterEach(() => {
    resetRuntime();
});

/** Create a minimal fake trial for grading pipeline tests. */
function makeAgent(overrides?: {
    workspace?: string;
    log?: LogEntry[];
    messages?: Array<{ role: 'user' | 'agent'; content: string }>;
    transcriptStr?: string;
}): Agent {
    const workspace = overrides?.workspace ?? '/fake/workspace';
    const log = overrides?.log ?? [];
    const messages = overrides?.messages ?? [
        { role: 'user' as const, content: 'Do the thing' },
        { role: 'agent' as const, content: 'Done' },
    ];
    const transcriptStr = overrides?.transcriptStr ?? '[User]\nDo the thing\n\n[Agent]\nDone';

    return {
        workspace,
        log,
        messages,
        llm: mockLLM,
        transcript: () => transcriptStr,
        exec: async (_cmd: string): Promise<CommandResult> => ({
            stdout: '', stderr: '', exitCode: 0,
        }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

function makeCheck(name: string, passes: boolean, weight = 1): CheckScorer {
    return { type: 'check', name, weight, fn: () => passes };
}

function makeScore(name: string, value: number | { score: number; details?: string }, weight = 1): ScoreScorer {
    return { type: 'score', name, weight, fn: () => value };
}

function makeJudge(name: string, rubric = 'Is it good?', weight = 1): JudgeScorer {
    return { type: 'judge', name, weight, rubric };
}

function makeToolUsage(name: string, expectations: ToolUsageScorer['expectations'] = [], weight = 1): ToolUsageScorer {
    return { type: 'tool_usage', name, weight, expectations };
}

// --- Behavior 1-3: Check scorers ---

describe('check scorers in pipeline', () => {
    it('1: single check passes → score 1.0', async () => {
        const result = await evaluate(makeAgent(), [makeCheck('passes', true)]);
        expect(result.score).toBe(1.0);
        expect(result.scorers[0].score).toBe(1.0);
        expect(result.scorers[0].type).toBe('check');
    });

    it('2: single check fails → score 0.0', async () => {
        const result = await evaluate(makeAgent(), [makeCheck('fails', false)]);
        expect(result.score).toBe(0.0);
        expect(result.scorers[0].score).toBe(0.0);
    });

    it('3: multiple checks — weighted average', async () => {
        const result = await evaluate(makeAgent(), [
            makeCheck('heavy-pass', true, 3),
            makeCheck('light-fail', false, 1),
        ]);
        expect(result.score).toBe(0.75);
    });
});

// --- Behavior 4-5: Score scorers ---

describe('score scorers in pipeline', () => {
    it('4: score scorer — returns number', async () => {
        const result = await evaluate(makeAgent(), [makeScore('coverage', 0.8)]);
        expect(result.score).toBe(0.8);
        expect(result.scorers[0].score).toBe(0.8);
        expect(result.scorers[0].type).toBe('score');
        expect(result.scorers[0].name).toBe('coverage');
    });

    it('5: score scorer — returns { score, details }', async () => {
        const result = await evaluate(makeAgent(), [
            makeScore('detailed', { score: 0.6, details: '6 of 10 fixed' }),
        ]);
        expect(result.score).toBe(0.6);
        expect(result.scorers[0].score).toBe(0.6);
        expect(result.scorers[0].details).toBe('6 of 10 fixed');
    });
});

// --- Behavior 6: Checks + scores run in phase 1 together ---

describe('phase 1: checks + scores together', () => {
    it('6: checks and scores combine in weighted average', async () => {
        const result = await evaluate(makeAgent(), [
            makeCheck('pass', true, 1),
            makeScore('half', 0.5, 1),
        ]);
        expect(result.score).toBe(0.75);
        expect(result.scorers).toHaveLength(2);
    });
});

// --- Behavior 7-9: Fail-fast ---

describe('fail-fast gate', () => {
    it('7: failed check skips judge scorers', async () => {
        const result = await evaluate(makeAgent(), [
            makeCheck('must-pass', false),
            makeJudge('quality'),
        ]);

        expect(mockLLM.calls).toHaveLength(0);
        const judgeResult = result.scorers.find(g => g.name === 'quality');
        expect(judgeResult!.score).toBe(0);
        expect(judgeResult!.details).toMatch(/skipped/i);
    });

    it('8: score returning 0 does NOT skip judges', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "good"}',
            provider: 'anthropic',
            model: 'test',
        });

        const result = await evaluate(makeAgent(), [
            makeScore('zero-score', 0),
            makeJudge('quality'),
        ]);

        expect(mockLLM.calls.length).toBeGreaterThan(0);
        expect(result.scorers.find(g => g.name === 'quality')!.score).toBe(0.9);
    });

    it('9: failFast: false disables the gate', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.7, "reasoning": "decent"}',
            provider: 'anthropic',
            model: 'test',
        });

        const result = await evaluate(makeAgent(), [
            makeCheck('fails', false),
            makeJudge('runs-anyway'),
        ], { failFast: false });

        expect(mockLLM.calls.length).toBeGreaterThan(0);
        expect(result.scorers.find(g => g.name === 'runs-anyway')!.score).toBe(0.7);
    });
});

// --- Behavior 10-12: Judge scorers ---

describe('judge scorers', () => {
    it('10: auto-includes transcript in prompt', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.85, "reasoning": "well done"}',
            provider: 'anthropic',
            model: 'test',
        });

        const trial = makeAgent({ transcriptStr: '[User]\nFix bugs\n\n[Agent]\nFixed all 3 bugs' });
        await evaluate(trial, [makeJudge('review')]);

        expect(mockLLM.calls).toHaveLength(1);
        const prompt = mockLLM.calls[0].prompt;
        expect(prompt).toContain('[User]\nFix bugs');
        expect(prompt).toContain('[Agent]\nFixed all 3 bugs');
    });

    it('11: input fields appended as additional context sections', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.8, "reasoning": "ok"}',
            provider: 'anthropic',
            model: 'test',
        });

        const judgeScorer: JudgeScorer = {
            type: 'judge', name: 'with-input', weight: 1,
            rubric: 'Check quality',
            input: { projectType: 'e-commerce', targetAudience: 'developers' },
        };

        await evaluate(makeAgent(), [judgeScorer]);

        const prompt = mockLLM.calls[0].prompt;
        expect(prompt).toContain('projectType');
        expect(prompt).toContain('e-commerce');
        expect(prompt).toContain('targetAudience');
        expect(prompt).toContain('developers');
    });

    it('12: includeToolEvents opt-in', async () => {
        const toolEvent: ToolEvent = {
            action: 'read_file', provider: 'claude', providerToolName: 'Read',
            summary: 'read_file /src/index.ts', confidence: 'high', rawSnippet: '...',
        };
        const trial = makeAgent({
            log: [{ type: 'tool_event', timestamp: new Date().toISOString(), tool_event: toolEvent }],
        });

        // WITH includeToolEvents
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "tools used well"}',
            provider: 'anthropic', model: 'test',
        });
        await evaluate(trial, [{
            type: 'judge', name: 'tool-aware', weight: 1,
            rubric: 'Did it use tools well?', includeToolEvents: true,
        }]);

        const prompt1 = mockLLM.calls[0].prompt;
        expect(prompt1).toContain('read_file');
        expect(prompt1).toContain('Read');

        // WITHOUT includeToolEvents
        mockLLM.clearCalls();
        mockLLM.queueResponse({
            text: '{"score": 0.5, "reasoning": "ok"}',
            provider: 'anthropic', model: 'test',
        });
        await evaluate(trial, [{
            type: 'judge', name: 'tool-unaware', weight: 1,
            rubric: 'Is it good?',
        }]);

        const prompt2 = mockLLM.calls[0].prompt;
        expect(prompt2).not.toContain('Tool Events');
    });
});

// --- Behavior 13: toolUsage scorer ---

describe('toolUsage scorers', () => {
    it('13: matches expectations against tool events', async () => {
        const trial = makeAgent({
            log: [
                { type: 'tool_event', timestamp: '', tool_event: { action: 'read_file', provider: 'claude', providerToolName: 'Read', summary: 'read /a.ts', confidence: 'high', rawSnippet: '...' } as ToolEvent },
                { type: 'tool_event', timestamp: '', tool_event: { action: 'write_file', provider: 'claude', providerToolName: 'Write', summary: 'write /b.ts', confidence: 'high', rawSnippet: '...' } as ToolEvent },
                { type: 'tool_event', timestamp: '', tool_event: { action: 'write_file', provider: 'claude', providerToolName: 'Write', summary: 'write /c.ts', confidence: 'high', rawSnippet: '...' } as ToolEvent },
            ],
        });

        const result = await evaluate(trial, [{
            type: 'tool_usage', name: 'tool-check', weight: 1,
            expectations: [
                { action: 'read_file', min: 1 },
                { action: 'write_file', min: 1, max: 5 },
            ],
        }]);

        expect(result.score).toBe(1.0);
        expect(result.scorers[0].type).toBe('tool_usage');
    });

    it('13b: fails when expectations not met', async () => {
        const trial = makeAgent({
            log: [
                { type: 'tool_event', timestamp: '', tool_event: { action: 'read_file', provider: 'claude', providerToolName: 'Read', summary: 'read /a.ts', confidence: 'high', rawSnippet: '...' } as ToolEvent },
            ],
        });

        const result = await evaluate(trial, [{
            type: 'tool_usage', name: 'missing-writes', weight: 1,
            expectations: [
                { action: 'read_file', min: 1 },
                { action: 'write_file', min: 2 },
            ],
        }]);

        expect(result.score).toBe(0.5);
    });
});

// --- Behavior 14: Full pipeline phase ordering ---

describe('full pipeline phase ordering', () => {
    it('14: checks+scores before judges before toolUsage', async () => {
        const executionOrder: string[] = [];

        mockLLM = createMockLLM({
            respond: () => {
                executionOrder.push('judge');
                return { text: '{"score": 0.8, "reasoning": "ok"}', provider: 'anthropic', model: 'test' };
            },
        });
        setRuntime({ llm: mockLLM });

        const trial = makeAgent({
            log: [{ type: 'tool_event', timestamp: '', tool_event: { action: 'read_file', provider: 'claude', providerToolName: 'Read', summary: 'read', confidence: 'high', rawSnippet: '...' } as ToolEvent }],
        });

        const checkScorer: CheckScorer = {
            type: 'check', name: 'check1', weight: 1,
            fn: () => { executionOrder.push('check'); return true; },
        };
        const scoreScorer: ScoreScorer = {
            type: 'score', name: 'score1', weight: 1,
            fn: () => { executionOrder.push('score'); return 0.9; },
        };

        // Pass scorers in reverse order — pipeline should still run them in phase order
        await evaluate(trial, [
            { type: 'tool_usage', name: 'tools1', weight: 1, expectations: [{ action: 'read_file', min: 1 }] },
            makeJudge('judge1'),
            scoreScorer,
            checkScorer,
        ]);

        const checkIdx = executionOrder.indexOf('check');
        const scoreIdx = executionOrder.indexOf('score');
        const judgeIdx = executionOrder.indexOf('judge');
        expect(checkIdx).toBeLessThan(judgeIdx);
        expect(scoreIdx).toBeLessThan(judgeIdx);
    });
});

// --- Behavior 15: Skipped scorers score 0 ---

describe('skipped scorers', () => {
    it('15: skipped scorers after fail-fast score 0 in result', async () => {
        const trial = makeAgent({
            log: [{ type: 'tool_event', timestamp: '', tool_event: { action: 'read_file', provider: 'claude', providerToolName: 'Read', summary: 'read', confidence: 'high', rawSnippet: '...' } as ToolEvent }],
        });

        const result = await evaluate(trial, [
            makeCheck('fails', false),
            makeJudge('skipped-judge'),
            makeToolUsage('skipped-tools', [{ action: 'read_file', min: 1 }]),
        ]);

        expect(result.scorers).toHaveLength(3);
        expect(result.scorers.find(g => g.name === 'skipped-judge')!.score).toBe(0);
        expect(result.scorers.find(g => g.name === 'skipped-tools')!.score).toBe(0);
        expect(mockLLM.calls).toHaveLength(0);
    });
});

// --- Behavior 16: Parallel execution within phases ---

describe('parallel execution', () => {
    it('16: scorers within a phase run in parallel', async () => {
        let firstStarted = false;
        let secondStartedBeforeFirstFinished = false;

        const slow1: CheckScorer = {
            type: 'check', name: 'slow1', weight: 1,
            fn: async () => {
                firstStarted = true;
                await new Promise(r => setTimeout(r, 50));
                return true;
            },
        };
        const slow2: CheckScorer = {
            type: 'check', name: 'slow2', weight: 1,
            fn: async () => {
                if (firstStarted) secondStartedBeforeFirstFinished = true;
                await new Promise(r => setTimeout(r, 50));
                return true;
            },
        };

        await evaluate(makeAgent(), [slow1, slow2]);
        expect(secondStartedBeforeFirstFinished).toBe(true);
    });
});

// --- Boundary tests ---

describe('boundary: ScorerContext.toolEvents', () => {
    it('all 4 scorer types receive ScorerContext with toolEvents', async () => {
        const toolEvent: ToolEvent = {
            action: 'read_file', provider: 'claude', providerToolName: 'Read',
            summary: 'read /src/main.ts', confidence: 'high', rawSnippet: '...',
        };
        const trial = makeAgent({
            log: [{ type: 'tool_event', timestamp: '', tool_event: toolEvent }],
        });

        // Track which scorers saw toolEvents and what they contained
        const seenByCheck: ToolEvent[] = [];
        const seenByScore: ToolEvent[] = [];

        mockLLM.queueResponse({
            text: '{"score": 1, "reasoning": "ok"}',
            provider: 'anthropic', model: 'test',
        });

        const checkScorer: CheckScorer = {
            type: 'check', name: 'ctx-check', weight: 1,
            fn: (ctx) => {
                seenByCheck.push(...ctx.toolEvents);
                return true;
            },
        };
        const scoreScorer: ScoreScorer = {
            type: 'score', name: 'ctx-score', weight: 1,
            fn: (ctx) => {
                seenByScore.push(...ctx.toolEvents);
                return 1;
            },
        };
        const judgeScorer: JudgeScorer = {
            type: 'judge', name: 'ctx-judge', weight: 1,
            rubric: 'Is it good?',
        };
        const toolUsageScorer: ToolUsageScorer = {
            type: 'tool_usage', name: 'ctx-tool-usage', weight: 1,
            expectations: [{ action: 'read_file', min: 1 }],
        };

        const result = await evaluate(trial, [checkScorer, scoreScorer, judgeScorer, toolUsageScorer]);

        // check scorer saw the tool events via ctx
        expect(seenByCheck).toHaveLength(1);
        expect(seenByCheck[0].action).toBe('read_file');

        // score scorer saw the tool events via ctx
        expect(seenByScore).toHaveLength(1);
        expect(seenByScore[0].action).toBe('read_file');

        // judge scorer ran (via the LLM mock)
        expect(mockLLM.calls).toHaveLength(1);

        // tool_usage scorer matched the event
        const toolResult = result.scorers.find(g => g.name === 'ctx-tool-usage');
        expect(toolResult!.score).toBe(1.0);
    });
});

describe('boundary: onResult captures results', () => {
    it('setRuntime({ onResult }) captures grade results from the pipeline', async () => {
        const captured: import('../src/sdk/types.js').EvalResult[] = [];
        setRuntime({
            llm: mockLLM,
            onResult: (result, _agent) => captured.push(result),
        });

        const result = await evaluate(makeAgent(), [
            makeCheck('boundary-check', true),
            makeScore('boundary-score', 0.8),
        ]);

        expect(captured).toHaveLength(1);
        expect(captured[0]).toBe(result);
        expect(captured[0].score).toBe(0.9); // (1.0 + 0.8) / 2
        expect(captured[0].scorers).toHaveLength(2);
    });

    it('captures the partial result before EvalScorerError is thrown in fail mode', async () => {
        const captured: import('../src/sdk/types.js').EvalResult[] = [];
        setRuntime({
            llm: mockLLM,
            onResult: (result, _agent) => captured.push(result),
        });

        await expect(evaluate(makeAgent(), [
            {
                type: 'score',
                name: 'throws',
                weight: 1,
                fn: async () => {
                    throw new Error('scorer blew up');
                },
            },
            makeScore('healthy', 0.7, 1),
        ], { onScorerError: 'fail' })).rejects.toBeInstanceOf(EvalScorerError);

        expect(captured).toHaveLength(1);
        expect(captured[0].scorers).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'throws', status: 'error' }),
            expect.objectContaining({ name: 'healthy', score: 0.7 }),
        ]));
    });
});

describe('scorer error handling', () => {
    it('excludes errored scorers from the weighted average by default', async () => {
        const result = await evaluate(makeAgent(), [
            {
                type: 'score',
                name: 'throws',
                weight: 2,
                fn: async () => {
                    throw new Error('score infra failed');
                },
            },
            makeScore('healthy', 0.8, 1),
        ]);

        expect(result.score).toBe(0.8);
        expect(result.scorers).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'throws',
                status: 'error',
                score: 0,
                details: 'score infra failed',
            }),
            expect.objectContaining({
                name: 'healthy',
                score: 0.8,
            }),
        ]));
        expect((result as import('../src/sdk/types.js').RecordedEvalResult).trial?.scorer_results.find((scorer: any) => scorer.details === 'score infra failed')).toEqual(
            expect.objectContaining({
                status: 'error',
            }),
        );
    });

    it('treats errored scorers as zero when onScorerError is zero', async () => {
        const result = await evaluate(makeAgent(), [
            {
                type: 'score',
                name: 'throws',
                weight: 2,
                fn: async () => {
                    throw new Error('score infra failed');
                },
            },
            makeScore('healthy', 0.8, 1),
        ], { onScorerError: 'zero' });

        expect(result.score).toBeCloseTo((0 * 2 + 0.8) / 3, 5);
        expect(result.scorers.find((scorer) => scorer.name === 'throws')).toEqual(
            expect.objectContaining({
                status: 'error',
                score: 0,
            }),
        );
    });

    it('throws EvalScorerError after all scorers complete when onScorerError is fail', async () => {
        const completed: string[] = [];

        await expect(evaluate(makeAgent(), [
            {
                type: 'score',
                name: 'throws',
                weight: 1,
                fn: async () => {
                    completed.push('throws');
                    throw new Error('judge provider timeout');
                },
            },
            {
                type: 'score',
                name: 'healthy',
                weight: 1,
                fn: async () => {
                    completed.push('healthy');
                    return 0.9;
                },
            },
        ], { onScorerError: 'fail' })).rejects.toMatchObject({
            name: 'EvalScorerError',
            message: expect.stringContaining('judge provider timeout'),
        });

        try {
            await evaluate(makeAgent(), [
                {
                    type: 'score',
                    name: 'throws',
                    weight: 1,
                    fn: async () => {
                        throw new Error('judge provider timeout');
                    },
                },
                makeScore('healthy', 0.9, 1),
            ], { onScorerError: 'fail' });
        } catch (error) {
            expect(error).toBeInstanceOf(EvalScorerError);
            expect((error as EvalScorerError).scorerErrors).toEqual([
                expect.objectContaining({
                    name: 'throws',
                    status: 'error',
                    details: 'judge provider timeout',
                }),
            ]);
        }

        expect(completed).toEqual(['throws', 'healthy']);
    });

    it('marks fail-fast skipped scorers with skipped status', async () => {
        const result = await evaluate(makeAgent(), [
            makeCheck('must-pass', false),
            makeJudge('judge-skipped'),
            makeToolUsage('tools-skipped'),
        ]);

        expect(result.scorers.find((scorer) => scorer.name === 'judge-skipped')).toEqual(
            expect.objectContaining({
                status: 'skipped',
                details: 'skipped (fail-fast)',
            }),
        );
        expect(result.scorers.find((scorer) => scorer.name === 'tools-skipped')).toEqual(
            expect.objectContaining({
                status: 'skipped',
                details: 'skipped (fail-fast)',
            }),
        );
        expect((result as import('../src/sdk/types.js').RecordedEvalResult).trial?.scorer_results).toEqual(expect.arrayContaining([
            expect.objectContaining({ scorer_type: 'llm_rubric', status: 'skipped' }),
            expect.objectContaining({ scorer_type: 'tool_usage', status: 'skipped' }),
        ]));
    });

    it('marks thrown check and tool usage scorers as errors with message-only details', async () => {
        const result = await evaluate(makeAgent({
            log: [{
                type: 'tool_event',
                timestamp: '',
                tool_event: {
                    action: 'read_file',
                    provider: 'claude',
                    providerToolName: 'Read',
                    summary: 'read file',
                    confidence: 'high',
                    rawSnippet: '...',
                },
            }],
        }), [
            {
                type: 'check',
                name: 'throws-check',
                weight: 1,
                fn: async () => {
                    throw new Error('check exploded');
                },
            },
            {
                type: 'tool_usage',
                name: 'throws-tool-usage',
                weight: 1,
                expectations: [
                    {
                        action: 'read_file',
                        get min() {
                            throw new Error('tool usage exploded');
                        },
                    } as never,
                ],
            },
        ], { failFast: false });

        expect(result.scorers.find((scorer) => scorer.name === 'throws-check')).toEqual(
            expect.objectContaining({
                status: 'error',
                details: 'check exploded',
            }),
        );
        expect(result.scorers.find((scorer) => scorer.name === 'throws-tool-usage')).toEqual(
            expect.objectContaining({
                status: 'error',
                details: 'tool usage exploded',
            }),
        );
    });
});
