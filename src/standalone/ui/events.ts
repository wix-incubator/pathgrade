export const STANDALONE_UI_PROTOCOL_VERSION = 1 as const;
export const STANDALONE_UI_FD = 3 as const;

export type StandaloneCaseState = 'passed' | 'failed' | 'skipped' | 'pending';

export type StandaloneUiEvent =
    | {
        v: 1;
        type: 'run_start';
        files: Array<{ id: string; name: string }>;
        startedAt: number;
    }
    | {
        v: 1;
        type: 'case_start';
        id: string;
        file: string;
        name: string;
        startedAt: number;
    }
    | {
        v: 1;
        type: 'case_finish';
        id: string;
        file: string;
        name: string;
        state: StandaloneCaseState;
        durationMs: number;
        score?: number;
    }
    | {
        v: 1;
        type: 'run_finish';
        status: 'pass' | 'fail';
        fileCount: number;
        passed: number;
        failed: number;
        skipped: number;
        durationMs: number;
        overallScore: number;
        threshold?: number;
        resultsPath: string;
    }
    | {
        v: 1;
        type: 'run_error';
    };

export function isStandaloneUiEvent(value: unknown): value is StandaloneUiEvent {
    if (!isRecord(value) || value.v !== STANDALONE_UI_PROTOCOL_VERSION || typeof value.type !== 'string') {
        return false;
    }
    if (value.type === 'run_error') return true;
    if (value.type === 'run_start') {
        return Array.isArray(value.files)
            && value.files.every(file => isRecord(file) && typeof file.id === 'string' && typeof file.name === 'string')
            && typeof value.startedAt === 'number';
    }
    if (value.type === 'case_start') {
        return hasCaseIdentity(value) && typeof value.startedAt === 'number';
    }
    if (value.type === 'case_finish') {
        return hasCaseIdentity(value)
            && isCaseState(value.state)
            && typeof value.durationMs === 'number'
            && (value.score === undefined || typeof value.score === 'number');
    }
    if (value.type === 'run_finish') {
        return (value.status === 'pass' || value.status === 'fail')
            && ['fileCount', 'passed', 'failed', 'skipped', 'durationMs', 'overallScore']
                .every(key => typeof value[key] === 'number')
            && (value.threshold === undefined || typeof value.threshold === 'number')
            && typeof value.resultsPath === 'string';
    }
    return false;
}

function hasCaseIdentity(value: Record<string, unknown>): boolean {
    return typeof value.id === 'string'
        && typeof value.file === 'string'
        && typeof value.name === 'string';
}

function isCaseState(value: unknown): value is StandaloneCaseState {
    return value === 'passed' || value === 'failed' || value === 'skipped' || value === 'pending';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
