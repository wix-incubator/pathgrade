import { describe, expect, it, vi } from 'vitest';
import type { AdapterLifecycleHooks } from '../src/runners/adapter.js';
import { installVitestLifecycle } from '../src/runners/vitest-lifecycle.js';

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
});
