import { describe, expect, it } from 'vitest';
import { classifyStandaloneVitestFailure } from '../src/standalone/diagnostics.js';

describe('standalone Vitest diagnostics', () => {
    it('classifies arbitrary unresolved imports as project dependencies', () => {
        expect(classifyStandaloneVitestFailure(
            'Failed to resolve import "zod" from "/repo/example.eval.ts"',
        )).toEqual({
            kind: 'project-dependency',
            message: 'pathgrade standalone: project dependency "zod" is unavailable; install the application dependencies or remove that import',
        });
    });

    it.each(['vitest', '@wix/pathgrade'])(
        'classifies unresolved %s as a packaging defect',
        (specifier) => {
            expect(classifyStandaloneVitestFailure(
                `Cannot find package '${specifier}' imported from /repo/example.eval.ts`,
            )).toMatchObject({ kind: 'packaging' });
        },
    );

    it('classifies a transitive failure inside the installed tool graph as packaging', () => {
        expect(classifyStandaloneVitestFailure(
            'Failed to resolve import "tiny-invariant" from "/tool/node_modules/@wix/pathgrade/dist/sdk/index.js"',
        )).toMatchObject({ kind: 'packaging' });
    });

    it('keeps a bare package imported by the eval classified as a project dependency', () => {
        expect(classifyStandaloneVitestFailure(
            'Failed to resolve import "tiny-invariant" from "/repo/example.eval.ts"',
        )).toMatchObject({ kind: 'project-dependency' });
    });

    it('leaves relative import failures as the original Vitest diagnostic', () => {
        expect(classifyStandaloneVitestFailure(
            'Failed to resolve import "./missing.js" from "/repo/example.eval.ts"',
        )).toBeUndefined();
    });
});
