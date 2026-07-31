import { describe, expect, it } from 'vitest';
import {
    resolveBundledCodexCommand,
    verifyBundledCodexRuntime,
} from '../src/agents/codex-runtime.js';

describe('bundled Codex runtime', () => {
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
