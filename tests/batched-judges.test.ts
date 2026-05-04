import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { JudgeScorer, Agent } from '../src/sdk/types.js';
import type { CommandResult, LogEntry } from '../src/types.js';
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

describe('batched judge execution', () => {
    it('1: multiple judges with same model batched into single LLM call', async () => {
        // Return a batch response with scores for all rubrics
        mockLLM.queueResponse({
            text: JSON.stringify([
                { scorer_name: 'quality', score: 0.9, reasoning: 'good quality' },
                { scorer_name: 'completeness', score: 0.8, reasoning: 'mostly complete' },
                { scorer_name: 'clarity', score: 0.7, reasoning: 'somewhat clear' },
            ]),
            provider: 'anthropic',
            model: 'test',
            inputTokens: 500,
            outputTokens: 100,
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate the quality' },
            { type: 'judge', name: 'completeness', weight: 1, rubric: 'Rate completeness' },
            { type: 'judge', name: 'clarity', weight: 1, rubric: 'Rate clarity' },
        ];

        const result = await evaluate(makeAgent(), judges);

        // Should be ONE LLM call, not three
        expect(mockLLM.calls).toHaveLength(1);
        // All three judges should have results
        expect(result.scorers).toHaveLength(3);
        expect(result.scorers.find(s => s.name === 'quality')!.score).toBe(0.9);
        expect(result.scorers.find(s => s.name === 'completeness')!.score).toBe(0.8);
        expect(result.scorers.find(s => s.name === 'clarity')!.score).toBe(0.7);
    });

    it('2: judges with different models run individually', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "good"}',
            provider: 'anthropic', model: 'test',
        });
        mockLLM.queueResponse({
            text: '{"score": 0.8, "reasoning": "ok"}',
            provider: 'anthropic', model: 'test',
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'judge-a', weight: 1, rubric: 'Rate A', model: 'claude-sonnet-4-20250514' },
            { type: 'judge', name: 'judge-b', weight: 1, rubric: 'Rate B', model: 'claude-haiku-4-5-20251001' },
        ];

        const result = await evaluate(makeAgent(), judges);

        // Two separate calls for different models
        expect(mockLLM.calls).toHaveLength(2);
        expect(result.scorers).toHaveLength(2);
    });

    it('3: batch parse failure falls back to individual calls', async () => {
        // First call (batch) returns unparseable response
        mockLLM.queueResponse({
            text: 'I cannot parse this into JSON array',
            provider: 'anthropic', model: 'test',
        });
        // Fallback individual calls
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "good"}',
            provider: 'anthropic', model: 'test',
        });
        mockLLM.queueResponse({
            text: '{"score": 0.8, "reasoning": "ok"}',
            provider: 'anthropic', model: 'test',
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'judge-1', weight: 1, rubric: 'Rate 1' },
            { type: 'judge', name: 'judge-2', weight: 1, rubric: 'Rate 2' },
        ];

        const result = await evaluate(makeAgent(), judges);

        // 1 batch attempt + 2 individual fallbacks = 3 calls
        expect(mockLLM.calls).toHaveLength(3);
        expect(result.scorers).toHaveLength(2);
        expect(result.scorers.find(s => s.name === 'judge-1')!.score).toBe(0.9);
        expect(result.scorers.find(s => s.name === 'judge-2')!.score).toBe(0.8);
    });

    it('4: single judge runs individually (no batching needed)', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.85, "reasoning": "great"}',
            provider: 'anthropic', model: 'test',
        });

        const judges: JudgeScorer[] = [
            { type: 'judge', name: 'solo', weight: 1, rubric: 'Rate it' },
        ];

        const result = await evaluate(makeAgent(), judges);

        expect(mockLLM.calls).toHaveLength(1);
        expect(result.scorers[0].score).toBe(0.85);
    });

    it('5: judge prompts do not include runtime policy metadata from the session log', async () => {
        mockLLM.queueResponse({
            text: '{"score": 0.9, "reasoning": "good"}',
            provider: 'anthropic',
            model: 'test',
        });

        const agent: Agent = {
            ...makeAgent(),
            log: [
            {
                type: 'agent_result',
                timestamp: '2026-01-01T00:00:00.000Z',
                assistant_message: 'Done',
                runtime_policies_applied: [
                    { id: 'noninteractive-user-question', version: '1' },
                ],
            } satisfies LogEntry,
            ],
        };

        await evaluate(agent, [
            { type: 'judge', name: 'quality', weight: 1, rubric: 'Rate the quality' },
        ]);

        const prompt = mockLLM.calls[0]?.prompt ?? '';
        expect(prompt).toContain('## Session Transcript');
        expect(prompt).not.toContain('Runtime policy:');
        expect(prompt).not.toContain('noninteractive-user-question');
    });
});
