import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { JudgeScorer, Agent } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';
import { evaluate } from '../src/sdk/evaluate.js';
import { setRuntime, resetRuntime } from '../src/sdk/eval-runtime.js';
import { createMockLLM, type MockLLM } from '../src/utils/llm-mocks.js';

let mockLLM: MockLLM;

function makeAgent(): Agent {
    return {
        workspace: '/fake',
        log: [],
        messages: [
            { role: 'user', content: 'Do the thing' },
            { role: 'agent', content: 'Done' },
        ],
        llm: mockLLM,
        transcript: () => '[User]\nDo the thing\n\n[Agent]\nDone',
        exec: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

beforeEach(() => {
    mockLLM = createMockLLM();
    setRuntime({ llm: mockLLM });
});

afterEach(() => {
    resetRuntime();
});

describe('token tracking in evaluation results', () => {
    it('1: eval result includes token usage from judge calls', async () => {
        mockLLM.queueResponse({
            text: JSON.stringify([
                { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                { scorer_name: 'completeness', score: 0.8, reasoning: 'ok' },
            ]),
            provider: 'anthropic',
            model: 'test',
            inputTokens: 500,
            outputTokens: 100,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
            { type: 'judge', name: 'completeness', weight: 1, rubric: 'Rate completeness' },
        ];

        const result = await evaluate(makeAgent(), judges);

        expect(result.tokenUsage).toBeDefined();
        expect(result.tokenUsage!.inputTokens).toBe(500);
        expect(result.tokenUsage!.outputTokens).toBe(100);
    });

    it('2: token usage is zero when no judge calls are made', async () => {
        const result = await evaluate(makeAgent(), [
            { type: 'check', name: 'simple', weight: 1, fn: () => true },
        ]);

        expect(result.tokenUsage).toBeDefined();
        expect(result.tokenUsage!.inputTokens).toBe(0);
        expect(result.tokenUsage!.outputTokens).toBe(0);
    });

    it('3: evaluate uses a pre-supplied tracked LLM instead of creating its own', async () => {
        const runtimeLLM = createMockLLM();
        setRuntime({ llm: runtimeLLM });

        const injectedLLM = createMockLLM({
            responses: [
                {
                    text: 'persona reply',
                    provider: 'anthropic', model: 'test',
                    inputTokens: 400, outputTokens: 80,
                },
                {
                    text: JSON.stringify([
                        { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                    ]),
                    provider: 'anthropic', model: 'test',
                    inputTokens: 400, outputTokens: 80,
                },
            ],
        });

        // Simulate prior persona calls already captured by this tracker
        await injectedLLM.call('persona prompt', {});

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];

        const result = await evaluate(makeAgent(), judges, { llm: injectedLLM });

        // Judge call should go through injected LLM, not the runtime one
        expect(runtimeLLM.calls).toHaveLength(0);
        expect(injectedLLM.calls).toHaveLength(2); // 1 persona + 1 judge

        // Token usage is now delta — only the judge call, not prior persona tokens
        expect(result.tokenUsage).toEqual({ inputTokens: 400, outputTokens: 80 });
    });

    it('4: trial result surfaces tokenUsage from tracked LLM', async () => {
        mockLLM.queueResponse({
            text: JSON.stringify([
                { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
            ]),
            provider: 'anthropic',
            model: 'test',
            inputTokens: 500,
            outputTokens: 100,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];

        const result = await evaluate(makeAgent(), judges) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result.trial).toBeDefined();
        expect(result.trial!.input_tokens).toBe(500);
        expect(result.trial!.output_tokens).toBe(100);
    });

    it('5: evaluate reads agent.llm directly (no WeakMap registration needed)', async () => {
        const injectedLLM = createMockLLM({
            responses: [{
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 250, outputTokens: 50,
            }],
        });

        // Agent exposes llm directly — no registerAgentLLM needed
        const agent: Agent = {
            ...makeAgent(),
            llm: injectedLLM,
        };

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];

        // No explicit opts.llm — evaluate should read agent.llm
        const result = await evaluate(agent, judges);

        expect(mockLLM.calls).toHaveLength(0); // runtime LLM not used
        expect(injectedLLM.calls).toHaveLength(1);
        expect(result.tokenUsage).toEqual({ inputTokens: 250, outputTokens: 50 });
    });

    it('6: full flow — trial has delta tokens, conversation tokens attributed separately', async () => {
        const trackedLLM = createMockLLM({
            responses: [
                {
                    text: 'persona reply',
                    provider: 'anthropic', model: 'test',
                    inputTokens: 150, outputTokens: 30,
                },
                {
                    text: JSON.stringify([
                        { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                    ]),
                    provider: 'anthropic', model: 'test',
                    inputTokens: 350, outputTokens: 70,
                },
            ],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        // Simulate persona call through agent.llm (pre-evaluate tokens)
        await agent.llm.call('persona prompt', {});

        // evaluate reads agent.llm directly
        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];
        const result = await evaluate(agent, judges) as import('../src/sdk/types.js').RecordedEvalResult;

        // Trial has only judge delta tokens
        expect(result.trial!.input_tokens).toBe(350);
        expect(result.trial!.output_tokens).toBe(70);
        // Conversation tokens attributed separately
        expect(result.trial!.conversation_input_tokens).toBe(150);
        expect(result.trial!.conversation_output_tokens).toBe(30);
    });

    it('7: delta tokens — trial contains only judge tokens, not conversation tokens', async () => {
        const trackedLLM = createMockLLM({
            responses: [{
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 350, outputTokens: 70,
            }],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        // Simulate conversation tokens accumulated before evaluate()
        agent.llm.addTokens!(5000, 1000);

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];
        const result = await evaluate(agent, judges) as import('../src/sdk/types.js').RecordedEvalResult;

        // Trial should contain only the judge delta, not the conversation total
        expect(result.trial!.input_tokens).toBe(350);
        expect(result.trial!.output_tokens).toBe(70);
    });

    it('8: conversation tokens attributed on first evaluate()', async () => {
        const trackedLLM = createMockLLM({
            responses: [{
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 200, outputTokens: 40,
            }],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        // Simulate conversation tokens
        agent.llm.addTokens!(8000, 2000);

        const result = await evaluate(agent, [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ]) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result.trial!.conversation_input_tokens).toBe(8000);
        expect(result.trial!.conversation_output_tokens).toBe(2000);
    });

    it('9: conversation tokens are zero on subsequent evaluate() calls', async () => {
        const trackedLLM = createMockLLM({
            defaultResponse: {
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 100, outputTokens: 20,
            },
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        // Simulate conversation tokens
        agent.llm.addTokens!(5000, 1000);

        // First evaluate — gets conversation attribution
        await evaluate(agent, [
            { type: 'judge', name: 'q1', weight: 1, rubric: 'Rate' },
        ]);

        // Second evaluate — no conversation attribution
        const result2 = await evaluate(agent, [
            { type: 'judge', name: 'q2', weight: 1, rubric: 'Rate' },
        ]) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result2.trial!.conversation_input_tokens ?? 0).toBe(0);
        expect(result2.trial!.conversation_output_tokens ?? 0).toBe(0);
        // But judge delta tokens should still be present
        expect(result2.trial!.input_tokens).toBe(100);
        expect(result2.trial!.output_tokens).toBe(20);
    });

    it('10: no pre-existing tokens — conversation fields are zero, delta captures everything', async () => {
        mockLLM.queueResponse({
            text: JSON.stringify([
                { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
            ]),
            provider: 'anthropic', model: 'test',
            inputTokens: 500, outputTokens: 100,
        });

        const result = await evaluate(makeAgent(), [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ]) as import('../src/sdk/types.js').RecordedEvalResult;

        // No conversation tokens — agent.llm starts at 0
        expect(result.trial!.conversation_input_tokens ?? 0).toBe(0);
        expect(result.trial!.conversation_output_tokens ?? 0).toBe(0);
        // All tokens in the delta
        expect(result.trial!.input_tokens).toBe(500);
        expect(result.trial!.output_tokens).toBe(100);
    });

    it('11a: conversation_cost_usd is populated from the pre-evaluate cost snapshot', async () => {
        // Mirrors test 6 (conversation_input_tokens / conversation_output_tokens),
        // for cost. AgentImpl's `sendTurn` calls `addCost` per turn; the cost
        // accumulated before `evaluate()` runs is attributed to the trial as
        // `conversation_cost_usd`, separate from any future judge cost (which
        // today is zero — judges do not yet expose cost).
        const trackedLLM = createMockLLM({
            responses: [
                {
                    text: JSON.stringify([
                        { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                    ]),
                    provider: 'anthropic', model: 'test',
                    inputTokens: 350, outputTokens: 70,
                },
            ],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        // Simulate two Claude SDK turns reporting cost via addCost
        agent.llm.addCost!(0.0125);
        agent.llm.addCost!(0.0008);

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];
        const result = await evaluate(agent, judges) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result.trial!.conversation_cost_usd).toBeCloseTo(0.0133, 10);
    });

    it('11b: conversation_cost_usd is omitted when no cost was accumulated before evaluate()', async () => {
        // Conservative shape — agents that don't expose turn cost (Codex /
        // Cursor today) must not appear as zero-cost runs in the trial. The
        // field stays undefined so the consumer can detect "no cost data"
        // cleanly. Same rule as conversation_input_tokens (test 9).
        const trackedLLM = createMockLLM({
            responses: [{
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 200, outputTokens: 40,
            }],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];
        const result = await evaluate(agent, judges) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result.trial).not.toHaveProperty('conversation_cost_usd');
    });

    it('11c: total_cost_usd is omitted while judge providers do not expose cost (conservative gate)', async () => {
        // `total_cost_usd` is emitted only when *all* included components
        // have known cost. Today judge LLM
        // providers do not expose cost, so this field is never emitted —
        // even when the conversation cost is known. Adding judge cost in a
        // future change is what unlocks this field.
        const trackedLLM = createMockLLM({
            responses: [{
                text: JSON.stringify([
                    { scorer_name: 'quality', score: 0.9, reasoning: 'good' },
                ]),
                provider: 'anthropic', model: 'test',
                inputTokens: 200, outputTokens: 40,
            }],
        });
        const agent: Agent = {
            ...makeAgent(),
            llm: trackedLLM,
        };
        agent.llm.addCost!(0.05);

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate quality' },
        ];
        const result = await evaluate(agent, judges) as import('../src/sdk/types.js').RecordedEvalResult;

        expect(result.trial).not.toHaveProperty('total_cost_usd');
    });

    it('11: individual judge calls aggregate token usage', async () => {
        // Two judges with different models → individual calls
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "good"}',
            provider: 'anthropic', model: 'test',
            inputTokens: 300, outputTokens: 50,
        });
        mockLLM.queueResponse({
            text: '{"score": 0.8, "reasoning": "ok"}',
            provider: 'anthropic', model: 'test',
            inputTokens: 200, outputTokens: 30,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'judge-a', weight: 1, rubric: 'Rate A', model: 'claude-sonnet-4-20250514' },
            { type: 'judge', name: 'judge-b', weight: 1, rubric: 'Rate B', model: 'claude-haiku-4-5-20251001' },
        ];

        const result = await evaluate(makeAgent(), judges);

        expect(result.tokenUsage).toBeDefined();
        expect(result.tokenUsage!.inputTokens).toBe(500); // 300 + 200
        expect(result.tokenUsage!.outputTokens).toBe(80);  // 50 + 30
    });
});
