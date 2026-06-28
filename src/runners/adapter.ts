import type { PathgradeSelectionReport } from '../types.js';
import type { Agent, PathgradeTestMeta, RecordedEvalResult } from '../sdk/types.js';
import type { CaseContextScope } from '../sdk/case-context.js';
import type { NormalizedRunSnapshot } from './model.js';

export const runnerAdapterContractVersion = 1;

export interface RunnerAdapter {
    readonly name: string;

    discover(input: AdapterDiscoveryInput): Promise<AdapterDiscoveryResult>;

    invoke(input: AdapterInvocationInput): Promise<AdapterRunHandle>;

    collectNormalizedRunSnapshot(run: AdapterRunHandle): Promise<NormalizedRunSnapshot>;
}

export interface AdapterDiscoveryInput {
    cwd: string;
    include?: string[];
    exclude?: string[];
    selection?: PathgradeSelectionReport;
}

export interface AdapterDiscoveryResult {
    units: AdapterEvalUnit[];
    diagnostics?: AdapterDiagnostic[];
}

export interface AdapterEvalUnit {
    id: string;
    displayName: string;
    sourceRef?: string;
    native?: unknown;
}

export interface AdapterDiagnostic {
    severity: 'info' | 'warning' | 'error';
    message: string;
    sourceRef?: string;
}

export interface AdapterInvocationInput {
    discovered: AdapterDiscoveryResult;
    argv: string[];
    env: NodeJS.ProcessEnv;
    lifecycle: AdapterLifecycleHooks;
    signal?: AbortSignal;
}

export interface AdapterRunHandle {
    adapterName: string;
    status: AdapterRunStatus;
    exitCode: number;
    native?: unknown;
    diagnostics?: AdapterDiagnostic[];
}

export type AdapterRunStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'parked';

export interface AdapterLifecycleHooks {
    onResult(event: EvalResultEvent): void;
    withCaseContext<T>(context: AdapterCaseContext, run: () => T): T;
    flushCase(caseId: string): Promise<PathgradeTestMeta[]>;
    cleanupRun(): Promise<void>;
}

export interface AdapterCaseContext {
    caseId: string;
    caseName: string;
    filePath?: string;
    sourceRef?: string;
    runnerNativeId?: string;
    scope: CaseContextScope;
}

export interface EvalResultEvent {
    result: RecordedEvalResult;
    agent: Agent;
}
