import { describe, expect, it } from 'vitest';
import {
    assertStandalonePlatform,
    StandaloneConfigurationError,
    validateStandaloneInvocation,
} from '../src/standalone/validation.js';
import { assertStandaloneAgent } from '../src/sdk/agent-resolution.js';

describe('standalone invocation validation', () => {
    it.each(['jest', 'node-test', './adapter.mjs'])('rejects adapter %s', (adapterName) => {
        expect(() => validateStandaloneInvocation({ adapterName, runnerArgs: [] }))
            .toThrow(StandaloneConfigurationError);
    });

    it.each([
        ['--config', 'vitest.config.ts'],
        ['--config=vitest.config.ts'],
        ['-c', 'vitest.config.ts'],
        ['--reporter=dot'],
        ['--root', '/tmp/elsewhere'],
        ['--dir=other'],
        ['--project', 'other'],
        ['--watch'],
        ['--browser'],
        ['--mergeReports'],
        ['--environment', 'jsdom'],
        ['--unknown-future-flag'],
    ])('rejects runner arguments outside the allowlist', (...runnerArgs) => {
        expect(() => validateStandaloneInvocation({ adapterName: 'vitest', runnerArgs }))
            .toThrow(/standalone runner allows only eval-file filters and -t\/--testNamePattern/);
    });

    it.each([
        ['sample.eval.ts'],
        ['sample.eval.ts', '--testNamePattern=creates file'],
        ['sample.eval.ts', '--testNamePattern', 'creates file'],
        ['sample.eval.ts', '-t', 'creates file'],
        ['one.eval.ts', 'two.eval.ts', '-t=creates file'],
    ])('accepts positional filters and test-name filters: %j', (...runnerArgs) => {
        expect(() => validateStandaloneInvocation({
            adapterName: 'vitest',
            runnerArgs,
        })).not.toThrow();
    });

    it('rejects options after the runner separator when they are not allowlisted', () => {
        expect(() => validateStandaloneInvocation({
            adapterName: 'vitest',
            runnerArgs: ['--', '--root', '/tmp/elsewhere'],
        })).toThrow(StandaloneConfigurationError);
    });

    it.each([
        { nodeMajor: 20, platform: 'linux' as const, arch: 'x64' },
        { nodeMajor: 23, platform: 'linux' as const, arch: 'x64' },
        { nodeMajor: 25, platform: 'linux' as const, arch: 'x64' },
        { nodeMajor: 22, platform: 'win32' as const, arch: 'x64' },
        { nodeMajor: 24, platform: 'darwin' as const, arch: 'ia32' },
    ])('rejects unsupported platform input %#', (input) => {
        expect(() => assertStandalonePlatform(input)).toThrow(StandaloneConfigurationError);
    });

    it.each([
        { nodeMajor: 22, platform: 'linux' as const, arch: 'x64' },
        { nodeMajor: 24, platform: 'darwin' as const, arch: 'arm64' },
    ])('accepts supported platform input %#', (input) => {
        expect(() => assertStandalonePlatform(input)).not.toThrow();
    });

    it('rejects Cursor and Codex exec before standalone workspace setup', () => {
        expect(() => assertStandaloneAgent('cursor')).toThrow(/Cursor/);
        expect(() => assertStandaloneAgent('codex', 'exec')).toThrow(/app-server/);
        expect(() => assertStandaloneAgent('claude')).not.toThrow();
        expect(() => assertStandaloneAgent('codex', 'app-server')).not.toThrow();
    });
});
