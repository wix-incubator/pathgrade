import type { ToolEvent } from '../tool-events.js';
import type { ScorerResultEntry, ToolExpectation } from './types.js';

export function clamp(n: number): number {
    return Math.max(0, Math.min(1, n));
}

export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function matchesExpectation(event: ToolEvent, expectation: ToolExpectation): boolean {
    if (event.action !== expectation.action) return false;
    if (expectation.toolName && event.providerToolName !== expectation.toolName) return false;
    if (expectation.path && event.arguments?.path !== expectation.path) return false;
    if (expectation.commandContains) {
        const cmd = String(event.arguments?.cmd || event.arguments?.command || '');
        if (!cmd.includes(expectation.commandContains)) return false;
    }
    if (expectation.argumentPattern) {
        const re = new RegExp(expectation.argumentPattern);
        const values = Object.values(event.arguments || {}).filter((v): v is string => typeof v === 'string');
        if (!values.some((v) => re.test(v))) return false;
    }
    return true;
}

export function makeErroredResult(
    type: ScorerResultEntry['type'],
    name: string,
    weight: number,
    error: unknown,
): ScorerResultEntry {
    return {
        name,
        type,
        score: 0,
        weight,
        details: getErrorMessage(error),
        status: 'error',
    };
}
