import path from 'node:path';
import type { TaskMeta } from 'vitest';
import type { Agent, PathgradeTestMeta, RecordedEvalResult } from '../sdk/types.js';
import { subscribeToEvalResults, type ResultObserverHandle } from '../sdk/result-capture.js';
import {
    getCurrentCaseContext,
    installCaseContextProvider,
    runWithCaseContext,
    type CaseContext,
    type CaseContextProviderHandle,
} from '../sdk/case-context.js';
import { lifecycleCore, type LifecycleAgentOwner } from '../sdk/lifecycle.js';
import type { AdapterCaseContext, AdapterLifecycleHooks, EvalResultEvent } from './adapter.js';

export type VitestAfterEachFn = (fn: (ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) => void;
export type VitestAfterAllFn = (fn: () => Promise<void>) => void;
export type VitestAroundEachFn = (
    fn: (
        runTest: () => Promise<void>,
        ctx: { task: { id: string; name: string; meta: Record<string, unknown>; suite?: unknown } },
    ) => Promise<void>,
) => void;

export interface VitestLifecycleInstallInput {
    afterEach: VitestAfterEachFn;
    afterAll?: VitestAfterAllFn;
    aroundEach?: VitestAroundEachFn;
    lifecycle?: AdapterLifecycleHooks;
    subscribeToResults?: (callback: (event: EvalResultEvent) => void) => ResultObserverHandle;
    installFileContextProvider?: () => CaseContextProviderHandle;
}

export interface VitestLifecycleInstallHandle {
    restore(): void;
}

export function createVitestLifecycleHooks(): AdapterLifecycleHooks {
    return {
        onResult: event => recordVitestResult(event.result, event.agent),
        withCaseContext: (context, run) => runWithCaseContext(toCaseContext(context), run),
        flushCase: caseId => lifecycleCore.flushCase({ caseId }),
        cleanupRun: () => lifecycleCore.cleanupAll(),
    };
}

export function installVitestLifecycle(input: VitestLifecycleInstallInput): VitestLifecycleInstallHandle {
    const lifecycle = input.lifecycle ?? createVitestLifecycleHooks();
    const resultCaptureHandle = (input.subscribeToResults ?? defaultSubscribeToResults)(
        event => lifecycle.onResult(event),
    );
    const fileContextHandle = (input.installFileContextProvider ?? defaultInstallFileContextProvider)();
    let fileContextRestored = false;
    let resultsUnsubscribed = false;

    input.aroundEach?.(async (runTest, { task }) => lifecycle.withCaseContext(caseContextForTask(task), runTest));
    input.afterEach(async ({ task }) => {
        const results = await lifecycle.flushCase(task.id);

        if (results.length > 0) {
            (task.meta as Pick<TaskMeta, 'pathgrade'>).pathgrade = results;
        }
    });
    input.afterAll?.(async () => {
        await lifecycle.cleanupRun();
        restoreFileContext();
    });

    return {
        restore() {
            restoreFileContext();
            if (!resultsUnsubscribed) {
                resultsUnsubscribed = true;
                resultCaptureHandle.unsubscribe();
            }
        },
    };

    function restoreFileContext(): void {
        if (fileContextRestored) return;
        fileContextRestored = true;
        fileContextHandle.restore();
    }
}

export function currentVitestAgentOwner(resultCaptureActive: boolean): LifecycleAgentOwner | null {
    const current = getCurrentCaseContext();
    if (current.status === 'active') {
        return current.context.scope === 'runner-case'
            ? { type: 'runner-case', caseId: current.context.caseId }
            : { type: 'runner-suite-shared', caseId: current.context.caseId };
    }

    const taskId = currentTaskId();
    if (resultCaptureActive) return null;
    return taskId ? { type: 'runner-case', caseId: taskId } : { type: 'manual' };
}

export function trackVitestAgent(agent: Agent, resultCaptureActive: boolean): void {
    lifecycleCore.registerAgent(agent, currentVitestAgentOwner(resultCaptureActive));
}

export function untrackVitestAgent(agent: Agent): void {
    lifecycleCore.untrackAgent(agent);
}

export function releaseVitestAgent(agent: Agent): void {
    lifecycleCore.releaseAgent(agent);
}

export function resetVitestLifecycle(handle: VitestLifecycleInstallHandle | null): void {
    lifecycleCore.reset();
    handle?.restore();
}

function defaultSubscribeToResults(callback: (event: EvalResultEvent) => void): ResultObserverHandle {
    return subscribeToEvalResults(
        ({ result, agent }) => callback({ result, agent }),
        { owner: 'adapter', key: 'vitest-lifecycle' },
    );
}

function defaultInstallFileContextProvider(): CaseContextProviderHandle {
    return installCaseContextProvider(currentFileContext);
}

function toCaseContext(context: AdapterCaseContext): CaseContext {
    return {
        caseId: context.caseId,
        caseName: context.caseName,
        filePath: context.filePath ?? context.sourceRef ?? '',
        scope: context.scope,
    };
}

function currentTaskId(): string {
    try {
        return (globalThis as any).__vitest_worker__?.current?.id ?? '';
    } catch {
        return '';
    }
}

function filePathForTask(task: { suite?: unknown }): string {
    let current = task.suite as { filepath?: unknown; suite?: unknown } | undefined;
    while (current) {
        if (typeof current.filepath === 'string') return current.filepath;
        current = current.suite as { filepath?: unknown; suite?: unknown } | undefined;
    }
    try {
        return (globalThis as any).__vitest_worker__?.filepath ?? '';
    } catch {
        return '';
    }
}

function caseContextForTask(task: { id: string; name: string; suite?: unknown }): AdapterCaseContext {
    const filePath = filePathForTask(task);
    return {
        caseId: task.id,
        caseName: task.name,
        filePath,
        sourceRef: filePath,
        runnerNativeId: task.id,
        scope: 'runner-case',
    };
}

function currentFilePath(): string {
    try {
        return (globalThis as any).__vitest_worker__?.filepath ?? '';
    } catch {
        return '';
    }
}

function currentFileContext(): CaseContext | null {
    const filePath = currentFilePath();
    if (!filePath) return null;

    return {
        caseId: `file:${filePath}`,
        caseName: path.basename(filePath),
        filePath,
        scope: 'runner-suite-shared',
    };
}

function recordVitestResult(result: RecordedEvalResult, agent: Agent): void {
    const current = getCurrentCaseContext();
    const taskId = currentTaskId();
    let owner = lifecycleCore.getAgentOwner(agent);
    if (!owner && current.status === 'active') {
        owner = current.context.scope === 'runner-case'
            ? { type: 'runner-case', caseId: current.context.caseId }
            : { type: 'runner-suite-shared', caseId: current.context.caseId };
        lifecycleCore.registerAgent(agent, owner);
    } else if (!owner && taskId) {
        owner = { type: 'runner-case', caseId: taskId };
        lifecycleCore.registerAgent(agent, owner);
    }
    if (owner?.type !== 'runner-case' && (current.status !== 'active' || current.context.scope !== 'runner-case')) {
        if (!taskId) {
            lifecycleCore.recordResult(result, agent);
            return;
        }
        lifecycleCore.recordResult(result, agent, { type: 'runner-case', caseId: taskId });
        return;
    }

    lifecycleCore.recordResult(result, agent);
}

declare module 'vitest' {
    interface TaskMeta {
        pathgrade?: PathgradeTestMeta[];
    }
}
