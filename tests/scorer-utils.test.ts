import { describe, expect, it } from 'vitest';

import type { ToolEvent } from '../src/tool-events.js';
import type { ToolExpectation } from '../src/sdk/types.js';

import { clamp, getErrorMessage, matchesExpectation } from '../src/sdk/scorer-utils.js';

function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
    return {
        action: 'read_file',
        provider: 'claude',
        providerToolName: 'read_file',
        summary: '',
        confidence: 'high',
        rawSnippet: '',
        ...overrides,
    };
}

describe('scorer-utils clamp', () => {
    it.each([
        [-0.5, 0],
        [1.7, 1],
        [0.42, 0.42],
    ])('clamp(%f) → %f', (input, expected) => {
        expect(clamp(input)).toBe(expected);
    });
});

describe('scorer-utils getErrorMessage', () => {
    it.each([
        [new Error('boom'), 'boom'],
        ['oops', 'oops'],
        [42, '42'],
    ])('getErrorMessage(%p) → %p', (input, expected) => {
        expect(getErrorMessage(input)).toBe(expected);
    });
});

describe('scorer-utils matchesExpectation', () => {
    it('returns false when the action does not match', () => {
        const event = makeEvent({ action: 'read_file' });
        const expectation: ToolExpectation = { action: 'write_file' };
        expect(matchesExpectation(event, expectation)).toBe(false);
    });

    it('filters by toolName when specified', () => {
        const event = makeEvent({ providerToolName: 'str_replace' });
        expect(matchesExpectation(event, { action: 'read_file', toolName: 'read_file' })).toBe(false);
        expect(matchesExpectation(event, { action: 'read_file', toolName: 'str_replace' })).toBe(true);
    });

    it('filters by path against arguments.path', () => {
        const event = makeEvent({ arguments: { path: 'src/a.ts' } });
        expect(matchesExpectation(event, { action: 'read_file', path: 'src/b.ts' })).toBe(false);
        expect(matchesExpectation(event, { action: 'read_file', path: 'src/a.ts' })).toBe(true);
    });

    it('filters by commandContains against arguments.cmd or arguments.command', () => {
        const runShell = (args: Record<string, unknown>) =>
            makeEvent({ action: 'run_shell', providerToolName: 'bash', arguments: args });
        const exp: ToolExpectation = { action: 'run_shell', commandContains: 'yarn test' };

        expect(matchesExpectation(runShell({ cmd: 'yarn test --watch' }), exp)).toBe(true);
        expect(matchesExpectation(runShell({ command: 'yarn test' }), exp)).toBe(true);
        expect(matchesExpectation(runShell({ cmd: 'yarn lint' }), exp)).toBe(false);
        expect(matchesExpectation(runShell({}), exp)).toBe(false);
    });

    it('filters by argumentPattern against any string argument value', () => {
        const event = makeEvent({
            action: 'search_code',
            providerToolName: 'grep',
            arguments: { pattern: 'TODO', path: 'src/', maxResults: 5 },
        });
        const hit: ToolExpectation = { action: 'search_code', argumentPattern: '^TODO$' };
        const miss: ToolExpectation = { action: 'search_code', argumentPattern: '^FIXME$' };

        expect(matchesExpectation(event, hit)).toBe(true);
        expect(matchesExpectation(event, miss)).toBe(false);
    });
});
