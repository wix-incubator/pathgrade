import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
);

describe('package surface', () => {
    it('exposes Vitest through the adapter plugin subpath and keeps the legacy plugin shim', () => {
        expect(packageJson.exports['.'].default).toBe('./dist/sdk/index.js');
        expect(packageJson.exports['./plugin/vitest']).toEqual({
            types: './dist/adapters/vitest/index.d.ts',
            default: './dist/adapters/vitest/index.js',
        });
        expect(packageJson.exports['./plugin']).toEqual({
            types: './dist/plugin/index.d.ts',
            default: './dist/plugin/index.js',
        });
    });

    it('keeps Vitest as an optional peer for adapter users', () => {
        expect(packageJson.peerDependencies.vitest).toBeDefined();
        expect(packageJson.peerDependenciesMeta.vitest.optional).toBe(true);
    });
});
