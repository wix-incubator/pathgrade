import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { selectStandaloneEsmExportTarget } from './module-aliases.js';

const BUNDLED_VITEST_VERSION = '4.1.7';

export interface BundledVitestRuntime {
    cliPath: string;
    version: string;
    entryPath: string;
}

export function resolveBundledVitestCli(): BundledVitestRuntime {
    try {
        const require = createRequire(import.meta.url);
        const packageJsonPath = require.resolve('vitest/package.json');
        const packageJson = JSON.parse(
            fs.readFileSync(packageJsonPath, 'utf8'),
        ) as {
            version?: string;
            bin?: string | Record<string, string>;
            exports?: Record<string, unknown>;
        };
        const bin = typeof packageJson.bin === 'string'
            ? packageJson.bin
            : packageJson.bin?.vitest;
        const entry = selectStandaloneEsmExportTarget(packageJson.exports?.['.']);
        if (packageJson.version !== BUNDLED_VITEST_VERSION || !bin || !entry) {
            throw new Error('unexpected bundled Vitest metadata');
        }
        const packageRoot = path.dirname(packageJsonPath);
        return {
            cliPath: path.resolve(packageRoot, bin),
            version: packageJson.version,
            entryPath: path.resolve(packageRoot, entry),
        };
    } catch {
        throw new Error(
            `pathgrade standalone: bundled Vitest ${BUNDLED_VITEST_VERSION} ` +
            'could not be resolved; this is a Pathgrade packaging defect',
        );
    }
}
