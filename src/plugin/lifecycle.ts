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
import path from 'node:path';

// Extend vitest's TaskMeta to carry pathgrade results from worker → reporter.
// Lives here because lifecycle.ts is the module that writes to task.meta.pathgrade.
declare module 'vitest' {
    interface TaskMeta {
        pathgrade?: PathgradeTestMeta[];
    }
}

type AfterEachFn = (fn: (ctx: { task: { id: string; meta: Record<string, unknown> } }) => Promise<void>) => void;
type AfterAllFn = (fn: () => Promise<void>) => void;
type AroundEachFn = (
    fn: (
        runTest: () => Promise<void>,
        ctx: { task: { id: string; name: string; meta: Record<string, unknown>; suite?: unknown } },
    ) => Promise<void>,
) => void;

let resultCaptureHandle: ResultObserverHandle | null = null;
let fileContextHandle: CaseContextProviderHandle | null = null;

function currentTaskId(): string {
    try {
        return (globalThis as any).__vitest_worker__?.current?.id ?? '';
    } catch { return ''; }
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

function caseContextForTask(task: { id: string; name: string; suite?: unknown }): CaseContext {
    return {
        caseId: task.id,
        caseName: task.name,
        filePath: filePathForTask(task),
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

function currentAgentOwner(): LifecycleAgentOwner | null {
    const current = getCurrentCaseContext();
    if (current.status === 'active') {
        return current.context.scope === 'runner-case'
            ? { type: 'runner-case', caseId: current.context.caseId }
            : { type: 'runner-suite-shared', caseId: current.context.caseId };
    }

    const taskId = currentTaskId();
    if (resultCaptureHandle) return null;
    return taskId ? { type: 'runner-case', caseId: taskId } : { type: 'manual' };
}

function trackAgent(agent: Agent): void {
    lifecycleCore.registerAgent(agent, currentAgentOwner());
}

function untrackAgent(agent: Agent): void {
    lifecycleCore.untrackAgent(agent);
}

function releaseAgent(agent: Agent): void {
    lifecycleCore.releaseAgent(agent);
}

/**
 * Flush results and dispose agents for the current test. Agents created in
 * this test's scope are disposed after flushing. Shared agents (created in a
 * different scope, e.g. module-level or beforeAll) have their pending results
 * flushed but are kept alive for subsequent tests.
 */
async function flush(task: { id: string; meta: Pick<import('vitest').TaskMeta, 'pathgrade'> }): Promise<void> {
    const results: PathgradeTestMeta[] = await lifecycleCore.flushCase({ caseId: task.id });

    if (results.length > 0) {
        task.meta.pathgrade = results;
    }
}

function onResult(result: RecordedEvalResult, agent: Agent): void {
    const current = getCurrentCaseContext();
    const taskId = currentTaskId();
    const owner = lifecycleCore.getAgentOwner(agent);
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

/**
 * Dispose any agents still pending at end-of-file. Shared agents (created at
 * module scope or in beforeAll) have a stored task id that won't match any
 * per-test id in afterEach, so afterAll is their only disposal opportunity.
 * Without this, sandboxes leak and `debug: true` folders never get written.
 */
async function flushAll(): Promise<void> {
    await lifecycleCore.cleanupAll();
}

function reset(): void {
    lifecycleCore.reset();
    resultCaptureHandle?.unsubscribe();
    resultCaptureHandle = null;
    fileContextHandle?.restore();
    fileContextHandle = null;
}

function install(afterEach: AfterEachFn, afterAll?: AfterAllFn, aroundEach?: AroundEachFn): void {
    resultCaptureHandle = subscribeToEvalResults(
        ({ result, agent }) => onResult(result, agent),
        { owner: 'adapter', key: 'vitest-lifecycle' },
    );
    fileContextHandle?.restore();
    fileContextHandle = installCaseContextProvider(currentFileContext);
    if (aroundEach) {
        aroundEach(async (runTest, { task }) => runWithCaseContext(caseContextForTask(task), runTest));
    }
    afterEach(async ({ task }) => flush(task));
    if (afterAll) {
        afterAll(async () => {
            await flushAll();
            fileContextHandle?.restore();
            fileContextHandle = null;
        });
    }
}

export const lifecycle = {
    trackAgent,
    untrackAgent,
    releaseAgent,
    flush,
    flushAll,
    onResult,
    reset,
    install,
};
