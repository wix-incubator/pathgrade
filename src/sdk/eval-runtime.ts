import type { LLMPort } from '../utils/llm-types.js';
import type { Agent, RecordedEvalResult } from './types.js';
import { callLLM } from '../utils/llm.js';

export type { LLMPort } from '../utils/llm-types.js';

export interface EvalRuntime {
    llm: LLMPort;
    onResult: (result: RecordedEvalResult, agent: Agent) => void;
}

function makeDefaultRuntime(): EvalRuntime {
    return {
        llm: { call: (prompt, opts) => callLLM(prompt, opts) },
        onResult: () => {},
    };
}

let current: EvalRuntime = makeDefaultRuntime();

export function getRuntime(): EvalRuntime {
    return current;
}

export function setRuntime(partial: Partial<EvalRuntime>): void {
    current = { ...current, ...partial };
}

export function resetRuntime(): void {
    current = makeDefaultRuntime();
}
