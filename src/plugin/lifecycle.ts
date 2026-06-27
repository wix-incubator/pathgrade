import type { Agent, RecordedEvalResult } from '../sdk/types.js';
import {
    createVitestLifecycleHooks,
    installVitestLifecycle,
    releaseVitestAgent,
    resetVitestLifecycle,
    trackVitestAgent,
    untrackVitestAgent,
    type VitestAfterAllFn,
    type VitestAfterEachFn,
    type VitestAroundEachFn,
    type VitestLifecycleInstallHandle,
} from '../runners/vitest-lifecycle.js';

let installHandle: VitestLifecycleInstallHandle | null = null;

function trackAgent(agent: Agent): void {
    trackVitestAgent(agent, installHandle !== null);
}

function untrackAgent(agent: Agent): void {
    untrackVitestAgent(agent);
}

function releaseAgent(agent: Agent): void {
    releaseVitestAgent(agent);
}

async function flush(task: { id: string; meta: Record<string, unknown> }): Promise<void> {
    const results = await createVitestLifecycleHooks().flushCase(task.id);

    if (results.length > 0) {
        task.meta.pathgrade = results;
    }
}

function onResult(result: RecordedEvalResult, agent: Agent): void {
    createVitestLifecycleHooks().onResult({ result, agent });
}

async function flushAll(): Promise<void> {
    await createVitestLifecycleHooks().cleanupRun();
}

function reset(): void {
    resetVitestLifecycle(installHandle);
    installHandle = null;
}

function install(afterEach: VitestAfterEachFn, afterAll?: VitestAfterAllFn, aroundEach?: VitestAroundEachFn): void {
    installHandle?.restore();
    installHandle = installVitestLifecycle({ afterEach, afterAll, aroundEach });
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
