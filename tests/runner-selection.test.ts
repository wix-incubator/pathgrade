import { describe, expect, it } from 'vitest';
import { resolveRunnerAdapter } from '../src/runners/selection.js';

describe('resolveRunnerAdapter', () => {
    it('selects the Vitest adapter by default', () => {
        const adapter = resolveRunnerAdapter({});

        expect(adapter.name).toBe('vitest');
    });

    it('rejects unsupported adapter names with the requested name in the message', () => {
        expect(() => resolveRunnerAdapter({ adapterName: 'node-test' }))
            .toThrow(/Unsupported Pathgrade runner adapter: node-test/);
    });
});
