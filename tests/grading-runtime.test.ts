import { describe, it, expect, afterEach } from 'vitest';
import { getRuntime, setRuntime, resetRuntime } from '../src/sdk/eval-runtime.js';
import { evaluate } from '../src/sdk/evaluate.js';
import type { Agent, JudgeScorer } from '../src/sdk/types.js';
import type { LogEntry, CommandResult } from '../src/types.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

afterEach(() => {
    resetRuntime();
});

function makeAgent(overrides?: { workspace?: string; log?: LogEntry[]; transcriptStr?: string }): Agent {
    return {
        workspace: overrides?.workspace ?? '/fake',
        log: overrides?.log ?? [],
        messages: [{ role: 'user' as const, content: 'test' }, { role: 'agent' as const, content: 'done' }],
        llm: createMockLLM(),
        transcript: () => overrides?.transcriptStr ?? 'user: test\nagent: done',
        exec: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

describe('grading runtime', () => {
    it('getRuntime() returns a runtime with default LLM and no-op onResult', () => {
        const runtime = getRuntime();
        expect(runtime.llm).toBeDefined();
        expect(typeof runtime.llm.call).toBe('function');
        expect(runtime.onResult).toBeDefined();
        expect(typeof runtime.onResult).toBe('function');
        // onResult should be a no-op (calling it should not throw)
        runtime.onResult({ score: 1, scorers: [] }, makeAgent());
    });

    it('setRuntime({ llm }) overrides the LLM port', async () => {
        const fakeLLM = {
            call: async () => ({
                text: 'fake response',
                provider: 'anthropic' as const,
                model: 'fake-model',
            }),
        };

        setRuntime({ llm: fakeLLM });

        const runtime = getRuntime();
        expect(runtime.llm).toBe(fakeLLM);
        // onResult should still be the default no-op
        expect(typeof runtime.onResult).toBe('function');
        runtime.onResult({ score: 1, scorers: [] }, makeAgent());
    });

    it('resetRuntime() restores defaults after setRuntime override', () => {
        const fakeLLM = {
            call: async () => ({
                text: 'fake',
                provider: 'anthropic' as const,
                model: 'fake',
            }),
        };

        setRuntime({ llm: fakeLLM });
        expect(getRuntime().llm).toBe(fakeLLM);

        resetRuntime();

        const runtime = getRuntime();
        expect(runtime.llm).not.toBe(fakeLLM);
        expect(typeof runtime.llm.call).toBe('function');
        expect(typeof runtime.onResult).toBe('function');
    });
});

describe('judge scorer uses agent LLM', () => {
    it('evaluate() uses agent.llm for judge scorers', async () => {
        const mockLLM = createMockLLM({
            responses: [{
                text: '{"score": 0.75, "reasoning": "fake judge says good"}',
                provider: 'anthropic',
                model: 'fake-model',
            }],
        });

        const judgeScorer: JudgeScorer = {
            type: 'judge',
            name: 'quality',
            weight: 1,
            rubric: 'Is it good?',
            model: 'claude-test',
        };

        const agent: Agent = {
            ...makeAgent(),
            llm: mockLLM,
        };
        const result = await evaluate(agent, [judgeScorer]);

        // The fake LLM should have been called
        expect(mockLLM.calls).toHaveLength(1);
        // It should have received the prompt and model option
        expect(mockLLM.calls[0].opts).toEqual({ model: 'claude-test', cacheControl: true });
        // The score should come from the fake response
        expect(result.score).toBe(0.75);
        expect(result.scorers[0].details).toBe('fake judge says good');
    });

    it('evaluate() calls runtime.onResult with the grade result', async () => {
        const captured: import('../src/sdk/types.js').EvalResult[] = [];
        setRuntime({ onResult: (result) => captured.push(result) });

        const trial = makeAgent();
        const result = await evaluate(trial, [
            { type: 'check', name: 'always-pass', weight: 1, fn: () => true },
        ]);

        expect(captured).toHaveLength(1);
        expect(captured[0]).toBe(result);
        expect(captured[0].score).toBe(1);
        expect(captured[0].scorers).toHaveLength(1);
        expect(captured[0].scorers[0].name).toBe('always-pass');
    });

    it('evaluate() works with default no-op onResult (no crash)', async () => {
        // default runtime has onResult: () => {} — grade should not throw
        const result = await evaluate(makeAgent(), [
            { type: 'check', name: 'noop-check', weight: 1, fn: () => true },
        ]);
        expect(result.score).toBe(1);
    });

    it('agent.llm that throws yields score 0 with error details', async () => {
        const mockLLM = createMockLLM({
            responses: [{ throws: new Error('LLM service down') }],
        });

        const judgeScorer: JudgeScorer = {
            type: 'judge',
            name: 'quality',
            weight: 1,
            rubric: 'Is it good?',
        };

        const agent: Agent = {
            ...makeAgent(),
            llm: mockLLM,
        };
        const result = await evaluate(agent, [judgeScorer]);

        expect(mockLLM.calls).toHaveLength(1);
        expect(result.score).toBe(0);
        expect(result.scorers[0].score).toBe(0);
        expect(result.scorers[0].details).toContain('LLM service down');
    });
});
