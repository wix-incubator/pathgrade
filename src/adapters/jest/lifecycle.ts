import {
    installCaseContextProvider,
    subscribeToEvalResults,
    createRunnerLifecycleHooks,
    type CaseContext,
    type CaseContextProviderHandle,
    type ResultObserverHandle,
    type PathgradeTestMeta,
    type AdapterLifecycleHooks,
    type EvalResultEvent,
} from '@wix/pathgrade/adapter-kit';
import { jestCaseId } from './results.js';

export type JestHook = (fn: () => void | Promise<void>) => void;

export interface JestState {
    testPath?: string;
    currentTestName?: string;
}

export interface JestLifecycleInstallInput {
    beforeEach: JestHook;
    afterEach: JestHook;
    afterAll?: JestHook;
    getState: () => JestState;
    lifecycle?: AdapterLifecycleHooks;
    subscribeToResults?: (callback: (event: EvalResultEvent) => void) => ResultObserverHandle;
    installCaseContextProvider?: (provider: () => CaseContext | null) => CaseContextProviderHandle;
}

export interface JestLifecycleInstallHandle {
    restore(): void;
}

const metadataByCaseId = new Map<string, PathgradeTestMeta[]>();

export function installJestLifecycle(input: JestLifecycleInstallInput): JestLifecycleInstallHandle {
    const lifecycle = input.lifecycle ?? createRunnerLifecycleHooks();
    const occurrenceCounts = new Map<string, number>();
    let activeCase: CaseContext | null = null;
    let restored = false;
    const resultCapture = (input.subscribeToResults ?? defaultSubscribeToResults)(
        event => lifecycle.onResult(event),
    );
    const contextProvider = (input.installCaseContextProvider ?? installCaseContextProvider)(() => activeCase);

    metadataByCaseId.clear();

    input.beforeEach(() => {
        const state = input.getState();
        const filePath = state.testPath ?? 'jest';
        const caseName = state.currentTestName ?? 'Jest test';
        const caseId = jestCaseId({
            filePath,
            fullName: caseName,
            occurrenceCounts,
        });
        activeCase = {
            caseId,
            caseName,
            filePath,
            scope: 'runner-case',
        };
    });

    input.afterEach(async () => {
        const current = activeCase;
        if (!current) return;

        const metadata = await lifecycle.flushCase(current.caseId);
        if (metadata.length > 0) {
            metadataByCaseId.set(current.caseId, metadata);
        }
        activeCase = null;
    });

    input.afterAll?.(async () => {
        await lifecycle.cleanupRun();
        restore();
    });

    return { restore };

    function restore(): void {
        if (restored) return;
        restored = true;
        activeCase = null;
        resultCapture.unsubscribe();
        contextProvider.restore();
    }
}

export function getJestLifecycleMetadata(): Map<string, PathgradeTestMeta[]> {
    return new Map(metadataByCaseId);
}

export function resetJestLifecycleMetadata(): void {
    metadataByCaseId.clear();
}

function defaultSubscribeToResults(callback: (event: EvalResultEvent) => void): ResultObserverHandle {
    return subscribeToEvalResults(
        ({ result, agent }) => callback({ result, agent }),
        { owner: 'adapter', key: 'jest-lifecycle' },
    );
}
