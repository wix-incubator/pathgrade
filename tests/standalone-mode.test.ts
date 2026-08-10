import { describe, expect, it } from 'vitest';
import {
    isStandaloneMode,
    parseStandaloneCommand,
    PATHGRADE_STANDALONE_ENV,
} from '../src/standalone/mode.js';

describe('standalone mode', () => {
    it('uses an exact internal marker', () => {
        expect(PATHGRADE_STANDALONE_ENV).toBe('PATHGRADE_STANDALONE');
        expect(isStandaloneMode({ PATHGRADE_STANDALONE: '1' })).toBe(true);
        expect(isStandaloneMode({ PATHGRADE_STANDALONE: 'true' })).toBe(false);
        expect(isStandaloneMode({})).toBe(false);
    });

    it('selects standalone only through the scoped command namespace', () => {
        expect(parseStandaloneCommand(['run'])).toEqual({
            standalone: false,
            args: ['run'],
        });
        expect(parseStandaloneCommand(['standalone'])).toEqual({
            standalone: true,
            args: ['run'],
        });
        expect(parseStandaloneCommand(['standalone', 'run', 'example.eval.ts'])).toEqual({
            standalone: true,
            args: ['run', 'example.eval.ts'],
        });
        expect(parseStandaloneCommand(['standalone', 'affected', '--json'])).toEqual({
            standalone: true,
            args: ['affected', '--json'],
        });
    });
});
