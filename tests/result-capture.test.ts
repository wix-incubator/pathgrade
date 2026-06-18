import { describe, it, expect, afterEach } from 'vitest';
import {
    emitEvalResult,
    resetUserResultObservers,
    subscribeToEvalResults,
    resetAllResultObserversForTests,
} from '../src/sdk/result-capture.js';
import { evaluate } from '../src/sdk/evaluate.js';
import { resetRuntime, setRuntime } from '../src/sdk/eval-runtime.js';
import type { Agent, RecordedEvalResult } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

afterEach(() => {
    resetRuntime();
    resetAllResultObserversForTests();
});

function makeAgent(): Agent {
    return {
        workspace: '/fake',
        log: [],
        messages: [],
        llm: createMockLLM(),
        transcript: () => '',
        exec: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

function makeResult(score: number): RecordedEvalResult {
    return {
        score,
        scorers: [{ name: 'check', type: 'check', score, weight: 1 }],
    };
}

describe('result capture', () => {
    it('delivers the same live evaluation event to multiple observers', () => {
        const agent = makeAgent();
        const result = makeResult(0.75);
        const first: unknown[] = [];
        const second: unknown[] = [];

        subscribeToEvalResults((event) => first.push(event));
        subscribeToEvalResults((event) => second.push(event));

        emitEvalResult({ result, agent });

        expect(first).toEqual([{ result, agent }]);
        expect(second).toEqual([{ result, agent }]);
    });

    it('keeps adapter observers when user observers are reset', () => {
        const agent = makeAgent();
        const result = makeResult(1);
        const userEvents: unknown[] = [];
        const adapterEvents: unknown[] = [];

        subscribeToEvalResults((event) => userEvents.push(event), { owner: 'user' });
        subscribeToEvalResults((event) => adapterEvents.push(event), { owner: 'adapter' });

        resetUserResultObservers();
        emitEvalResult({ result, agent });

        expect(userEvents).toEqual([]);
        expect(adapterEvents).toEqual([{ result, agent }]);
    });

    it('returns an idempotent unsubscribe handle', () => {
        const agent = makeAgent();
        const events: unknown[] = [];
        const handle = subscribeToEvalResults((event) => events.push(event));

        handle.unsubscribe();
        handle.unsubscribe();
        emitEvalResult({ result: makeResult(0.5), agent });

        expect(events).toEqual([]);
    });

    it('does not duplicate delivery when the same adapter observer is reinstalled', () => {
        const agent = makeAgent();
        const result = makeResult(0.25);
        const events: unknown[] = [];

        subscribeToEvalResults((event) => events.push(event), { owner: 'adapter', key: 'vitest-lifecycle' });
        subscribeToEvalResults((event) => events.push(event), { owner: 'adapter', key: 'vitest-lifecycle' });

        emitEvalResult({ result, agent });

        expect(events).toEqual([{ result, agent }]);
    });

    it('continues delivering to adapter observers when a user observer throws', () => {
        const agent = makeAgent();
        const result = makeResult(0.9);
        const adapterEvents: unknown[] = [];

        subscribeToEvalResults(() => {
            throw new Error('observer failed');
        }, { owner: 'user' });
        subscribeToEvalResults((event) => adapterEvents.push(event), { owner: 'adapter' });

        expect(() => emitEvalResult({ result, agent })).not.toThrow();
        expect(adapterEvents).toEqual([{ result, agent }]);
    });

    it('captures live evaluate results with the source agent', async () => {
        const agent = makeAgent();
        const events: unknown[] = [];

        subscribeToEvalResults((event) => events.push(event));
        const result = await evaluate(agent, [
            { type: 'check', name: 'passes', weight: 1, fn: () => true },
        ]);

        expect(events).toEqual([{ result, agent }]);
    });

    it('bridges legacy runtime result callbacks into user-owned result observers', () => {
        const agent = makeAgent();
        const result = makeResult(0.6);
        const legacyEvents: unknown[] = [];

        setRuntime({ onResult: (capturedResult, capturedAgent) => legacyEvents.push({ result: capturedResult, agent: capturedAgent }) });
        emitEvalResult({ result, agent });

        expect(legacyEvents).toEqual([{ result, agent }]);
    });
});
