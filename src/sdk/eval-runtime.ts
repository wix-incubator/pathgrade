import type { LLMPort } from '../utils/llm-types.js';
import type { Agent, RecordedEvalResult } from './types.js';
import { callLLM } from '../utils/llm.js';
import {
    resetUserResultObservers,
    subscribeToEvalResults,
    type ResultObserverHandle,
} from './result-capture.js';

export type { LLMPort } from '../utils/llm-types.js';

export interface EvalRuntime {
    llm: LLMPort;
    /**
     * Legacy compatibility seam. `setRuntime({ onResult })` is bridged into
     * user-owned result observers; live capture is owned by result-capture.
     */
    onResult: (result: RecordedEvalResult, agent: Agent) => void;
}

function makeDefaultRuntime(): EvalRuntime {
    return {
        llm: { call: (prompt, opts) => callLLM(prompt, opts) },
        onResult: () => {},
    };
}

let current: EvalRuntime = makeDefaultRuntime();
let legacyRuntimeResultHandle: ResultObserverHandle | null = null;

export function getRuntime(): EvalRuntime {
    return current;
}

export function setRuntime(partial: Partial<EvalRuntime>): void {
    const { onResult, ...runtimeConfig } = partial;
    current = { ...current, ...runtimeConfig };

    if (onResult) {
        legacyRuntimeResultHandle?.unsubscribe();
        legacyRuntimeResultHandle = subscribeToEvalResults(
            ({ result, agent }) => onResult(result, agent),
            { owner: 'user', key: 'legacy-runtime-onResult' },
        );
    }
}

export function resetRuntime(): void {
    current = makeDefaultRuntime();
    legacyRuntimeResultHandle?.unsubscribe();
    legacyRuntimeResultHandle = null;
    resetUserResultObservers();
}
