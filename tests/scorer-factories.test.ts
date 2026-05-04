import { describe, it, expect } from 'vitest';

// Test the new scorer factories: score, judge, toolUsage
// check() is already tested in Issue 1 demo eval

describe('score() factory', () => {
    it('produces a ScoreScorer with correct fields from the scorers module', async () => {
        const { score } = await import('../src/sdk/scorers.js');
        const fn = () => 0.75;
        const scorer = score('lint-coverage', fn, { weight: 0.7 });

        expect(scorer.type).toBe('score');
        expect(scorer.name).toBe('lint-coverage');
        expect(scorer.weight).toBe(0.7);
        expect(scorer.fn).toBe(fn);
    });

    it('uses default weight of 1', async () => {
        const { score } = await import('../src/sdk/scorers.js');
        const scorer = score('default-weight', () => 0.5);
        expect(scorer.weight).toBe(1);
    });
});

describe('judge() factory', () => {
    it('produces a JudgeScorer with correct fields', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('brief-quality', {
            rubric: 'Does the brief cover scope and timeline?',
            weight: 0.3,
            model: 'claude-sonnet-4-20250514',
            includeToolEvents: true,
            input: { context: 'extra info' },
        });

        expect(scorer.type).toBe('judge');
        expect(scorer.name).toBe('brief-quality');
        expect(scorer.weight).toBe(0.3);
        expect(scorer.rubric).toBe('Does the brief cover scope and timeline?');
        expect(scorer.model).toBe('claude-sonnet-4-20250514');
        expect(scorer.includeToolEvents).toBe(true);
        expect(scorer.input).toEqual({ context: 'extra info' });
        expect(scorer.retry).toBeUndefined();
    });

    it('uses default weight of 1 and includeToolEvents false', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('quality', { rubric: 'Is it good?' });
        expect(scorer.weight).toBe(1);
        expect(scorer.includeToolEvents).toBeUndefined();
    });

    it('preserves the retry option', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('quality', { rubric: 'Is it good?', retry: 2 });
        expect(scorer.retry).toBe(2);
    });

    it('preserves dynamic input builders', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const input = async () => ({ context: 'from ctx' });
        const scorer = judge('quality', { rubric: 'Is it good?', input });
        expect(scorer.input).toBe(input);
    });

    it('preserves tools allowlist when provided', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', {
            rubric: 'rate',
            tools: ['readFile'],
            maxRounds: 5,
        });
        expect(scorer.tools).toEqual(['readFile']);
        expect(scorer.maxRounds).toBe(5);
    });

    it('does not set tools when omitted (default path unchanged)', async () => {
        const { judge } = await import('../src/sdk/scorers.js');
        const scorer = judge('q', { rubric: 'rate' });
        expect(scorer.tools).toBeUndefined();
        expect(scorer.maxRounds).toBeUndefined();
    });

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

describe('toolUsage() factory', () => {
    it('produces a ToolUsageScorer with correct fields', async () => {
        const { toolUsage } = await import('../src/sdk/scorers.js');
        const expectations = [
            { action: 'read_file' as const, min: 1 },
            { action: 'write_file' as const, min: 1, max: 3 },
        ];
        const scorer = toolUsage('used-correct-tools', expectations, { weight: 0.5 });

        expect(scorer.type).toBe('tool_usage');
        expect(scorer.name).toBe('used-correct-tools');
        expect(scorer.weight).toBe(0.5);
        expect(scorer.expectations).toBe(expectations);
    });

    it('uses default weight of 1', async () => {
        const { toolUsage } = await import('../src/sdk/scorers.js');
        const scorer = toolUsage('tools', [{ action: 'run_shell' as const }]);
        expect(scorer.weight).toBe(1);
    });
});
