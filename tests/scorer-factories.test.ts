import { describe, it, expect } from 'vitest';

describe('judge() factory', () => {
    it('auto-enables includeToolEvents when getToolEvents is in tools', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate', tools: ['getToolEvents'] });
        expect(scorer.includeToolEvents).toBe(true);
    });

    it('treats empty tools array as no tools (undefined)', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate', tools: [] });
        expect(scorer.tools).toBeUndefined();
    });

    it('defaults cacheControl to true when tools is a non-empty array', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate', tools: ['readFile'] });
        expect(scorer.cacheControl).toBe(true);
    });

    it('leaves cacheControl undefined when no tools (unchanged default path)', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate' });
        expect(scorer.cacheControl).toBeUndefined();
    });

    it('honors explicit cacheControl: false even when tools is set', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate', tools: ['readFile'], cacheControl: false });
        expect(scorer.cacheControl).toBe(false);
    });
});
