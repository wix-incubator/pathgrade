import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
);
describe('package surface', () => {
    it('exposes Vitest through the canonical adapter subpath and keeps plugin compatibility shims', () => {
        expect(packageJson.exports['.'].default).toBe('./dist/sdk/index.js');
        expect(packageJson.exports['./adapters/vitest']).toEqual({
            types: './dist/adapters/vitest/index.d.ts',
            default: './dist/adapters/vitest/index.js',
        });
        expect(packageJson.exports['./adapters/node-test']).toEqual({
            types: './dist/adapters/node-test/index.d.ts',
            default: './dist/adapters/node-test/index.js',
        });
        expect(packageJson.exports['./adapter-kit']).toEqual({
            types: './dist/adapter-kit/index.d.ts',
            default: './dist/adapter-kit/index.js',
        });
        expect(packageJson.exports['./plugin/vitest']).toEqual({
            types: './dist/adapters/vitest/index.d.ts',
            default: './dist/adapters/vitest/index.js',
        });
        expect(packageJson.exports['./plugin']).toEqual({
            types: './dist/plugin/index.d.ts',
            default: './dist/plugin/index.js',
        });
    });

    it('keeps runner packages as optional peers for adapter users', () => {
        expect(packageJson.peerDependencies.jest).toBeDefined();
        expect(packageJson.peerDependenciesMeta.jest.optional).toBe(true);
        expect(packageJson.peerDependencies.vitest).toBeDefined();
        expect(packageJson.peerDependenciesMeta.vitest.optional).toBe(true);
        expect(packageJson.dependencies.vitest).toBe('4.1.7');
        expect(packageJson.peerDependencies.vitest).toBe('^4.0.0');
    });

    it('exposes Jest through the built-in adapter subpaths', () => {
        expect(packageJson.exports['./adapters/jest']).toEqual({
            types: './dist/adapters/jest/index.d.ts',
            default: './dist/adapters/jest/index.js',
        });
        expect(packageJson.exports['./adapters/jest/setup']).toEqual({
            types: './dist/adapters/jest/setup.d.ts',
            default: './dist/adapters/jest/setup.js',
        });
        expect(packageJson.exports['./adapters/jest/reporter']).toEqual({
            types: './dist/adapters/jest/reporter.d.ts',
            default: './dist/adapters/jest/reporter.cjs',
        });
    });

    it('keeps the standalone runtime pins exact and publishes only the scoped package', () => {
        expect(packageJson.name).toBe('@wix/pathgrade');
        expect(packageJson.bin).toBe('bin/pathgrade.js');
        expect(packageJson.repository.url).toBe('git+https://github.com/wix-incubator/pathgrade.git');
        expect(packageJson.dependencies.vitest).toBe('4.1.7');
        expect(packageJson.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.2.116');
        expect(packageJson.dependencies['@openai/codex']).toBe('0.144.0');
        expect(packageJson.scripts['test:release-contracts']).toBe(
            'node tests/release-platform-evidence.test.mjs && node tests/publish-workflow-contract.test.mjs',
        );
        expect(packageJson.scripts.test).toBe(
            'yarn build && vitest run && yarn test:runner-cli-smoke && yarn test:standalone-package-smoke && yarn test:release-contracts',
        );
        expect(packageJson.files).toContain('dist/**/*.js');
        expect(packageJson).not.toHaveProperty('workspaces');
    });
});
