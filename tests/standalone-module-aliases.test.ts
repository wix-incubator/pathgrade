import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
    decodeStandaloneVitestPayload,
    encodeStandaloneVitestPayload,
    resolveStandaloneModuleAliases,
    selectStandaloneEsmExportTarget,
} from '../src/standalone/module-aliases.js';

describe('standalone Vitest aliases and payload', () => {
    it('round-trips only validated payload fields', () => {
        const payload = {
            root: '/tmp/target',
            include: ['**/*.eval.ts'],
            exclude: ['**/fixtures/**'],
            diagnostics: true,
            reporter: 'cli' as const,
            threshold: 0.8,
            cacheDir: '/tmp/pathgrade-cache',
        };
        expect(decodeStandaloneVitestPayload(encodeStandaloneVitestPayload(payload)))
            .toEqual(payload);
    });

    it('rejects malformed or unsafe payloads', () => {
        expect(() => decodeStandaloneVitestPayload(undefined)).toThrow();
        expect(() => decodeStandaloneVitestPayload(Buffer.from(JSON.stringify({
            root: 'relative',
            include: [],
            exclude: [],
            diagnostics: false,
            cacheDir: '/tmp/cache',
        })).toString('base64url'))).toThrow(/absolute/);
    });

    it('maps root Vitest plus supported scoped exports exactly', () => {
        const aliases = resolveStandaloneModuleAliases(
            path.resolve('.'),
            '/tool/node_modules/vitest/dist/index.js',
        );
        expect(aliases).toContainEqual({
            find: /^@wix\/pathgrade$/,
            replacement: path.resolve('dist/sdk/index.js'),
        });
        expect(aliases).toContainEqual({
            find: /^@wix\/pathgrade\/mcp-mock$/,
            replacement: path.resolve('dist/core/mcp-mock.js'),
        });
        expect(aliases).toContainEqual({
            find: /^vitest$/,
            replacement: '/tool/node_modules/vitest/dist/index.js',
        });
        expect(aliases.map(alias => alias.find.source)).not.toContain('vitest\\/config');
        expect(aliases).not.toContainEqual(expect.objectContaining({ find: /^pathgrade$/ }));
    });

    it('selects standalone ESM targets without requiring a default condition', () => {
        expect(selectStandaloneEsmExportTarget('./dist/sdk/index.js'))
            .toBe('./dist/sdk/index.js');
        expect(selectStandaloneEsmExportTarget({
            types: './dist/sdk/index.d.ts',
            import: './dist/sdk/index.js',
        })).toBe('./dist/sdk/index.js');
        expect(selectStandaloneEsmExportTarget({
            node: './dist/sdk/node.js',
            default: './dist/sdk/browser.js',
        })).toBe('./dist/sdk/node.js');
        expect(selectStandaloneEsmExportTarget({
            import: { default: './dist/sdk/nested.js' },
        })).toBe('./dist/sdk/nested.js');
        expect(selectStandaloneEsmExportTarget({
            require: './dist/sdk/index.cjs',
        })).toBeUndefined();
    });

    it('does not alias non-eval public entries', () => {
        const sources = resolveStandaloneModuleAliases(
            path.resolve('.'),
            '/tool/node_modules/vitest/dist/index.js',
        ).map(alias => alias.find.source);
        expect(sources).not.toContain('@wix\\/pathgrade\\/package\\.json');
        expect(sources).not.toContain('@wix\\/pathgrade\\/adapters\\/jest\\/reporter');
    });
});
