import { describe, expect, it, vi } from 'vitest';
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

    it('executes the packaged native artifact version probe without PATH lookup', async () => {
        await expect(verifyBundledCodexRuntime(resolveBundledCodexCommand()))
            .resolves.toEqual({
                packageVersion: '0.144.0',
                nativeVersion: '0.144.0',
                provenance: 'bundled',
            });
    });
});
