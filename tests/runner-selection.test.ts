import { describe, expect, it } from 'vitest';
import { loadRunnerAdapter } from '../src/runners/adapter-loader.js';
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

    it('loads the Jest adapter by shorthand package alias', async () => {
        const adapter = await loadRunnerAdapter({ adapterName: 'jest' });

        expect(adapter.name).toBe('jest');
    });

    it('rejects unsupported adapter names with the requested name in the message', () => {
        expect(() => resolveRunnerAdapter({ adapterName: 'mocha' }))
            .toThrow(/Unsupported Pathgrade runner adapter: mocha/);
    });
});
