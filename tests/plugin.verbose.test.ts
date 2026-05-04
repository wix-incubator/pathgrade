import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathgrade } from '../src/plugin/index.js';

const ORIGINAL_VERBOSE = process.env.PATHGRADE_VERBOSE;

beforeEach(() => {
    delete process.env.PATHGRADE_VERBOSE;
});

afterEach(() => {
    if (ORIGINAL_VERBOSE === undefined) {
        delete process.env.PATHGRADE_VERBOSE;
    } else {
        process.env.PATHGRADE_VERBOSE = ORIGINAL_VERBOSE;
    }
});

describe('pathgrade plugin verbose option', () => {
    it('sets PATHGRADE_VERBOSE=1 when env is unset and { verbose: true } is passed', () => {
        pathgrade({ verbose: true });
        expect(process.env.PATHGRADE_VERBOSE).toBe('1');
    });

    it('does not overwrite an explicit env value (env beats plugin option)', () => {
        process.env.PATHGRADE_VERBOSE = '0';
        pathgrade({ verbose: true });
        expect(process.env.PATHGRADE_VERBOSE).toBe('0');
    });

    it('leaves env untouched when verbose is not set on plugin options', () => {
        pathgrade({});
        expect(process.env.PATHGRADE_VERBOSE).toBeUndefined();
    });

    it('leaves env untouched when verbose is explicitly false', () => {
        pathgrade({ verbose: false });
        expect(process.env.PATHGRADE_VERBOSE).toBeUndefined();
    });
});
