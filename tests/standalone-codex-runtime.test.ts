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
        expect(runtime.provenance).toBe('bundled');
    });

    it('resolves the native artifact from a non-hoisted Codex installation', async () => {
        const fixtureRoot = mkdtempSync(join(tmpdir(), 'pathgrade-codex-non-hoisted-'));
        const codexRoot = join(fixtureRoot, 'node_modules', '@openai', 'codex');
        const packageByTarget: Record<string, { packageName: string; triple: string }> = {
            'darwin:x64': {
                packageName: '@openai/codex-darwin-x64',
                triple: 'x86_64-apple-darwin',
            },
            'darwin:arm64': {
                packageName: '@openai/codex-darwin-arm64',
                triple: 'aarch64-apple-darwin',
            },
            'linux:x64': {
                packageName: '@openai/codex-linux-x64',
                triple: 'x86_64-unknown-linux-musl',
            },
            'linux:arm64': {
                packageName: '@openai/codex-linux-arm64',
                triple: 'aarch64-unknown-linux-musl',
            },
        };
        const target = packageByTarget[`${process.platform}:${process.arch}`]!;
        const platformRoot = join(
            codexRoot,
            'node_modules',
            ...target.packageName.split('/'),
        );
        const nativeExecutable = join(platformRoot, 'vendor', target.triple, 'bin', 'codex');

        try {
            mkdirSync(join(codexRoot, 'bin'), { recursive: true });
            mkdirSync(join(platformRoot, 'vendor', target.triple, 'bin'), { recursive: true });
            writeFileSync(
                join(codexRoot, 'package.json'),
                JSON.stringify({
                    name: '@openai/codex',
                    version: '0.144.0',
                    bin: { codex: 'bin/codex.js' },
                }),
            );
            writeFileSync(join(codexRoot, 'bin', 'codex.js'), '');
            writeFileSync(
                join(platformRoot, 'package.json'),
                JSON.stringify({ name: target.packageName, version: '0.144.0' }),
            );
            writeFileSync(nativeExecutable, '');

            const runtimeModule = await import('../src/agents/codex-runtime.js') as unknown as {
                resolveBundledCodexNativeArtifact?: (packageJsonPath: string) => string;
            };
            expect(runtimeModule.resolveBundledCodexNativeArtifact).toBeTypeOf('function');
            expect(runtimeModule.resolveBundledCodexNativeArtifact?.(
                join(codexRoot, 'package.json'),
            )).toBe(realpathSync(nativeExecutable));
        } finally {
            rmSync(fixtureRoot, { recursive: true, force: true });
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
