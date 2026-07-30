import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildStandaloneVitestConfig } from '../src/standalone/vitest-config.js';

describe('standalone Vitest config', () => {
    it('keeps configuration and generated output inside the owned cache directory', () => {
        const targetRoot = '/tmp/target-project';
        const cacheDir = '/tmp/pathgrade-cache';
        const config = buildStandaloneVitestConfig({
            root: targetRoot,
            include: ['**/*.eval.ts'],
            exclude: ['**/fixtures/**'],
            diagnostics: true,
            reporter: 'json',
            threshold: 0.8,
            cacheDir,
        }, {
            packageRoot: path.resolve('.'),
            vitestEntry: '/tool/node_modules/vitest/dist/index.js',
        });

        expect(config.root).toBe(targetRoot);
        expect(config.envFile).toBe(false);
        expect(config.cacheDir).toBe('/tmp/pathgrade-cache/vite');
        expect(config.test?.include).toEqual(['**/*.eval.ts']);
        expect(config.test?.exclude).toEqual(['**/fixtures/**']);
        expect(config.test?.coverage?.reportsDirectory)
            .toBe('/tmp/pathgrade-cache/coverage');
        expect(config.test?.attachmentsDir).toBe('/tmp/pathgrade-cache/attachments');
        expect(config.test?.outputFile).toMatchObject({
            json: '/tmp/pathgrade-cache/reports/pathgrade.json',
            blob: '/tmp/pathgrade-cache/reports/vitest.blob',
        });

        const outputs = [
            config.cacheDir,
            config.test?.coverage?.reportsDirectory,
            config.test?.attachmentsDir,
            ...Object.values(config.test?.outputFile as Record<string, string>),
        ].filter((value): value is string => typeof value === 'string');
        expect(outputs.every(output => output.startsWith(`${cacheDir}/`))).toBe(true);
        expect(outputs.some(output => output === targetRoot || output.startsWith(`${targetRoot}/`)))
            .toBe(false);
    });
});
