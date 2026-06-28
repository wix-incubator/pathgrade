import { describe, expect, it } from 'vitest';
import { resolveRunnerAdapter } from '../src/runners/selection.js';

describe('resolveRunnerAdapter', () => {
    it('selects the Vitest adapter by default', () => {
        const adapter = resolveRunnerAdapter({});

        expect(adapter.name).toBe('vitest');
    });

    it('selects the node:test proof adapter by name', () => {
        const adapter = resolveRunnerAdapter({ adapterName: 'node-test' });

        expect(adapter.name).toBe('node-test');
    });

    it('rejects unsupported adapter names with the requested name in the message', () => {
        expect(() => resolveRunnerAdapter({ adapterName: 'jest' }))
            .toThrow(/Unsupported Pathgrade runner adapter: jest/);
    });
});
