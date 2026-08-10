import { describe, expect, it, vi } from 'vitest';
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    resolveBundledCodexCommand,
    resolveBundledCodexNativeArtifact,
    verifyBundledCodexRuntime,
} from '../src/agents/codex-runtime.js';

describe('bundled Codex runtime', () => {
    it('rejects native Windows before resolving a bundled artifact', () => {
        const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        try {
            expect(() => resolveBundledCodexCommand()).toThrow(
                'pathgrade standalone: native Windows is unsupported; use WSL with x64 or arm64',
            );
        } finally {
            platform.mockRestore();
        }
    });

    it('resolves the exact official package through Node', () => {
        const runtime = resolveBundledCodexCommand();
        expect(runtime.executable).toBe(process.execPath);
        expect(runtime.argsPrefix[0]).toMatch(/@openai[/\\]codex[/\\]bin[/\\]codex\.js$/);
        expect(runtime.packageVersion).toBe('0.144.0');
        expect(runtime.nativeVersion).toBe('0.144.0');
        expect(runtime.provenance).toBe('bundled');
    });

    it('resolves the native artifact from a non-hoisted Codex installation', () => {
        const fixture = createCodexFixture('0.144.0');
        try {
            expect(resolveBundledCodexNativeArtifact(fixture.packageJsonPath))
                .toBe(realpathSync(fixture.nativeExecutable));
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a mismatched native package version before reporting provenance', () => {
        const fixture = createCodexFixture('0.143.0');
        try {
            expect(() => resolveBundledCodexNativeArtifact(fixture.packageJsonPath))
                .toThrow(/native artifact version must be 0\.144\.0-(darwin|linux)-(arm64|x64)/);
        } finally {
            fixture.cleanup();
        }
    });

    it('executes the packaged native artifact version probe without PATH lookup', async () => {
        await expect(verifyBundledCodexRuntime(resolveBundledCodexCommand()))
            .resolves.toEqual({
                packageVersion: '0.144.0',
                nativeVersion: '0.144.0',
                provenance: 'bundled',
            });
    });
});

function createCodexFixture(nativeVersion: string): {
    packageJsonPath: string;
    nativeExecutable: string;
    cleanup: () => void;
} {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'pathgrade-codex-non-hoisted-'));
    const codexRoot = join(fixtureRoot, 'node_modules', '@openai', 'codex');
    const packageByTarget: Record<string, { packageName: string; triple: string; versionSuffix: string }> = {
        'darwin:x64': {
            packageName: '@openai/codex-darwin-x64',
            triple: 'x86_64-apple-darwin',
            versionSuffix: 'darwin-x64',
        },
        'darwin:arm64': {
            packageName: '@openai/codex-darwin-arm64',
            triple: 'aarch64-apple-darwin',
            versionSuffix: 'darwin-arm64',
        },
        'linux:x64': {
            packageName: '@openai/codex-linux-x64',
            triple: 'x86_64-unknown-linux-musl',
            versionSuffix: 'linux-x64',
        },
        'linux:arm64': {
            packageName: '@openai/codex-linux-arm64',
            triple: 'aarch64-unknown-linux-musl',
            versionSuffix: 'linux-arm64',
        },
    };
    const target = packageByTarget[`${process.platform}:${process.arch}`]!;
    const platformRoot = join(
        codexRoot,
        'node_modules',
        ...target.packageName.split('/'),
    );
    const packageJsonPath = join(codexRoot, 'package.json');
    const nativeExecutable = join(platformRoot, 'vendor', target.triple, 'bin', 'codex');

    mkdirSync(join(codexRoot, 'bin'), { recursive: true });
    mkdirSync(join(platformRoot, 'vendor', target.triple, 'bin'), { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify({
        name: '@openai/codex',
        version: '0.144.0',
        bin: { codex: 'bin/codex.js' },
    }));
    writeFileSync(join(codexRoot, 'bin', 'codex.js'), '');
    writeFileSync(
        join(platformRoot, 'package.json'),
        JSON.stringify({
            name: '@openai/codex',
            version: `${nativeVersion}-${target.versionSuffix}`,
        }),
    );
    writeFileSync(nativeExecutable, '');

    return {
        packageJsonPath,
        nativeExecutable,
        cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
    };
}
