import { describe, expect, it, vi } from 'vitest';
import type { AdapterLifecycleHooks } from '../src/runners/adapter.js';
import { installVitestLifecycle } from '../src/runners/vitest-lifecycle.js';
import type { Agent, RecordedEvalResult } from '../src/sdk/types.js';
import { lifecycleCore } from '../src/sdk/lifecycle.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

describe('Vitest adapter lifecycle wiring', () => {
    it('routes aroundEach, afterEach, and afterAll through adapter lifecycle hooks with stable case IDs', async () => {
        let afterEachCallback: ((ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) | undefined;
        let afterAllCallback: (() => Promise<void>) | undefined;
        let aroundEachCallback: ((runTest: () => Promise<void>, ctx: { task: { id: string; name: string; meta: Record<string, unknown>; suite?: unknown } }) => Promise<void>) | undefined;
        const events: string[] = [];
        const lifecycle: AdapterLifecycleHooks = {
            onResult: () => undefined,
            withCaseContext: async (context, run) => {
                events.push(`context:${context.caseId}:${context.caseName}:${context.scope}`);
                return await run();
            },
            flushCase: async caseId => {
                events.push(`flush:${caseId}`);
                return [{ score: 1, scorers: [] }];
            },
            cleanupRun: async () => {
                events.push('cleanup');
            },
        };

        const handle = installVitestLifecycle({
            afterEach: callback => {
                afterEachCallback = callback;
            },
            afterAll: callback => {
                afterAllCallback = callback;
            },
            aroundEach: callback => {
                aroundEachCallback = callback;
            },
            lifecycle,
            subscribeToResults: callback => {
                callback({ result: { score: 1, scorers: [] }, agent: {} as never });
                return { unsubscribe: vi.fn(() => events.push('unsubscribe')) };
            },
            installFileContextProvider: () => ({ restore: vi.fn(() => events.push('restore-file-context')) }),
        });

        const task = {
            id: 'task-1',
            name: 'keeps attribution',
            meta: {} as Record<string, unknown>,
            suite: { filepath: '/repo/keeps-attribution.eval.ts' },
        };

        await aroundEachCallback?.(async () => {
            events.push('run-test');
        }, { task });
        await afterEachCallback?.({ task });
        await afterAllCallback?.();
        handle.restore();

        expect(task.meta.pathgrade).toEqual([{ score: 1, scorers: [] }]);
        expect(events).toEqual([
            'context:task-1:keeps attribution:runner-case',
            'run-test',
            'flush:task-1',
            'cleanup',
            'restore-file-context',
            'unsubscribe',
        ]);
    });

    it('owns and disposes structural agents first observed through evaluate results', async () => {
        let afterEachCallback: ((ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) | undefined;
        let aroundEachCallback: ((runTest: () => Promise<void>, ctx: { task: { id: string; name: string; meta: Record<string, unknown>; suite?: unknown } }) => Promise<void>) | undefined;
        let resultCallback: ((event: { result: RecordedEvalResult; agent: Agent }) => void) | undefined;
        const agent = structuralAgent();

        const handle = installVitestLifecycle({
            afterEach: callback => { afterEachCallback = callback; },
            aroundEach: callback => { aroundEachCallback = callback; },
            subscribeToResults: callback => {
                resultCallback = callback;
                return { unsubscribe: vi.fn() };
            },
            installFileContextProvider: () => ({ restore: vi.fn() }),
        });
        const task = {
            id: 'structural-agent-case',
            name: 'structural agent case',
            meta: {} as Record<string, unknown>,
            suite: { filepath: '/repo/structural.eval.ts' },
        };

        await aroundEachCallback?.(async () => {
            resultCallback?.({
                result: { score: 1, scorers: [] },
                agent,
            });
        }, { task });
        await afterEachCallback?.({ task });
        handle.restore();
        lifecycleCore.reset();

        expect(task.meta.pathgrade).toEqual([expect.objectContaining({ score: 1 })]);
        expect(agent.dispose).toHaveBeenCalledOnce();
    });
});

function structuralAgent(): Agent & { dispose: ReturnType<typeof vi.fn> } {
    return {
        workspace: '/fake',
        log: [],
        messages: [],
        llm: createMockLLM(),
        transcript: () => '',
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('not used'); },
        runConversation: async () => ({
            turns: 0,
            completionReason: 'until' as const,
            turnTimings: [],
            stepResults: [],
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
    };
}
