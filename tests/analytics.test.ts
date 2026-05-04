import { describe, it, expect } from 'vitest';
import { calculateNormalizedGain, AnalyticsEngine } from '../src/analytics/engine.js';
import { EvalReport } from '../src/types.js';

describe('calculateNormalizedGain', () => {
    it.each([
        { with: 1.0, without: 0.5, expected: 1.0 },
        { with: 0.75, without: 0.5, expected: 0.5 },
        { with: 0.5, without: 0.5, expected: 0.0 },
        { with: 0.25, without: 0.5, expected: -0.5 },
    ])('NG($with, $without) = $expected', (tc) => {
        const ng = calculateNormalizedGain(tc.with, tc.without);
        expect(ng).toBeCloseTo(tc.expected, 3);
    });
});

describe('AnalyticsEngine.aggregate', () => {
    it('computes normalized gain per task', () => {
        const mockReports: EvalReport[] = [
            { task: 'task1', pass_rate: 0.5, pass_at_k: 0.5, pass_pow_k: 0.5, trials: [], skills_used: [] },
            { task: 'task1', pass_rate: 1.0, pass_at_k: 1.0, pass_pow_k: 1.0, trials: [], skills_used: ['skill1'] },
            { task: 'task2', pass_rate: 0.0, pass_at_k: 0.0, pass_pow_k: 0.0, trials: [], skills_used: [] },
            { task: 'task2', pass_rate: 0.5, pass_at_k: 0.5, pass_pow_k: 0.5, trials: [], skills_used: ['skill1'] },
        ];

        const engine = new AnalyticsEngine();
        const stats = engine.aggregate(mockReports);

        expect(stats.find(s => s.task === 'task1')?.normalizedGain).toBe(1.0);
        expect(stats.find(s => s.task === 'task2')?.normalizedGain).toBe(0.5);
    });
});
