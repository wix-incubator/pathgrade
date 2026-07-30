import path from 'node:path';
import { createRequire } from 'node:module';
import type { ViteUserConfig } from 'vitest/config';
import { pathgrade } from '../adapters/vitest/index.js';
import {
    decodeStandaloneVitestPayload,
    resolveStandaloneModuleAliases,
    STANDALONE_VITEST_PAYLOAD_ENV,
    type StandaloneVitestPayload,
} from './module-aliases.js';

export interface StandaloneVitestRuntimePaths {
    packageRoot: string;
    vitestEntry: string;
}

export type StandaloneVitestConfig = ViteUserConfig & { envFile: false };

export function buildStandaloneVitestConfig(
    payload: StandaloneVitestPayload,
    runtimePaths: StandaloneVitestRuntimePaths,
): StandaloneVitestConfig {
    const generated = {
        vite: path.join(payload.cacheDir, 'vite'),
        coverage: path.join(payload.cacheDir, 'coverage'),
        attachments: path.join(payload.cacheDir, 'attachments'),
        json: path.join(payload.cacheDir, 'reports', 'pathgrade.json'),
        blob: path.join(payload.cacheDir, 'reports', 'vitest.blob'),
    };
    for (const outputPath of Object.values(generated)) {
        assertOwnedOutputPath(payload.cacheDir, outputPath);
    }

    return {
        root: payload.root,
        envFile: false,
        envDir: payload.cacheDir,
        cacheDir: generated.vite,
        resolve: {
            alias: resolveStandaloneModuleAliases(
                runtimePaths.packageRoot,
                runtimePaths.vitestEntry,
            ),
        },
        plugins: [
            pathgrade({
                include: payload.include,
                exclude: payload.exclude,
                diagnostics: payload.diagnostics,
                reporter: payload.reporter,
                ci: { threshold: payload.threshold },
            }),
        ],
        test: {
            include: payload.include,
            exclude: payload.exclude,
            coverage: {
                reportsDirectory: generated.coverage,
            },
            attachmentsDir: generated.attachments,
            outputFile: {
                json: generated.json,
                blob: generated.blob,
            },
        },
    } as StandaloneVitestConfig;
}

function assertOwnedOutputPath(cacheDir: string, outputPath: string): void {
    const relative = path.relative(cacheDir, outputPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
            `pathgrade standalone: generated output escapes cache directory: ${outputPath}`,
        );
    }
}

function buildDefaultConfig(): ViteUserConfig {
    const encoded = process.env[STANDALONE_VITEST_PAYLOAD_ENV];
    if (!encoded) return {};

    const packageRoot = path.resolve(import.meta.dirname, '..', '..');
    const vitestEntry = createRequire(import.meta.url).resolve('vitest');
    return buildStandaloneVitestConfig(
        decodeStandaloneVitestPayload(encoded),
        { packageRoot, vitestEntry },
    );
}

export default buildDefaultConfig();
