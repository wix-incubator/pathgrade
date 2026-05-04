/**
 * Legacy auth tests — ported to resolveCredentials().
 * The comprehensive test suite is in credentials.test.ts.
 * These tests verify backward-compatible behavior for the original scenarios.
 */
import { afterEach, describe, it, expect } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { resolveCredentials, defaultPorts } from '../src/providers/credentials.js';

describe('resolveCredentials (legacy auth scenarios)', () => {
    const originalHome = process.env.HOME;

    afterEach(async () => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
    });

    it('claude on non-darwin forwards host ANTHROPIC_API_KEY', async () => {
        const ports = { ...defaultPorts(), platform: 'linux' as const };
        const result = await resolveCredentials('claude', {}, ports);
        if (process.env.ANTHROPIC_API_KEY) {
            expect(result.env.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY);
        } else {
            expect(result.env).toEqual({});
        }
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
    });

    it('claude on darwin with existing ANTHROPIC_API_KEY returns empty', async () => {
        const ports = { ...defaultPorts(), platform: 'darwin' as const };
        const result = await resolveCredentials('claude', { ANTHROPIC_API_KEY: 'sk-existing' }, ports);
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
    });

    it('claude on darwin without key attempts Keychain (may fail gracefully in CI)', async () => {
        const ports = { ...defaultPorts(), platform: 'darwin' as const };
        const result = await resolveCredentials('claude', {}, ports);
        // Either gets a token or returns empty — never throws
        expect(result.setupCommands).toEqual([]);
        expect(typeof result.env).toBe('object');
        expect(Array.isArray(result.copyFromHome)).toBe(true);
    });

    it('codex with OPENAI_API_KEY returns setupCommand', async () => {
        const result = await resolveCredentials('codex', { OPENAI_API_KEY: 'sk-test' });
        expect(result.env).toEqual({});
        expect(result.setupCommands).toHaveLength(1);
        expect(result.setupCommands[0]).toContain('codex login');
        expect(result.copyFromHome).toEqual([]);
    });

    it('codex without OPENAI_API_KEY uses cached auth.json when present', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-auth-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fakeHome, '.codex'));
        await fs.writeFile(path.join(fakeHome, '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}');

        try {
            const ports = { ...defaultPorts(), homedir: fakeHome, hostEnv: () => undefined };
            const result = await resolveCredentials('codex', {}, ports);
            expect(result.env).toEqual({});
            expect(result.setupCommands).toEqual([]);
            expect(result.copyFromHome).toEqual(['.codex/auth.json']);
        } finally {
            await fs.remove(fakeHome);
        }
    });

    it('codex without OPENAI_API_KEY returns empty when no cached auth exists', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-auth-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fakeHome);

        try {
            const ports = { ...defaultPorts(), homedir: fakeHome, hostEnv: () => undefined };
            const result = await resolveCredentials('codex', {}, ports);
            expect(result.env).toEqual({});
            expect(result.setupCommands).toEqual([]);
            expect(result.copyFromHome).toEqual([]);
        } finally {
            await fs.remove(fakeHome);
        }
    });
});
