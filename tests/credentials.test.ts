import { describe, it, expect } from 'vitest';
import { resolveCredentials, type CredentialPorts } from '../src/providers/credentials.js';

/** Stub ports — no real Keychain, no real filesystem, no process.env */
function stubPorts(overrides?: Partial<CredentialPorts>): CredentialPorts {
    return {
        hostEnv: () => undefined,
        platform: 'linux',
        homedir: '/home/test',
        readKeychainToken: async () => undefined,
        keychainEntryExists: async () => false,
        fileExists: async () => false,
        ...overrides,
    };
}

describe('resolveCredentials', () => {
    // --- Claude scenarios ---

    it('claude: user-provided ANTHROPIC_API_KEY → empty (trusted)', async () => {
        const result = await resolveCredentials(
            'claude',
            { ANTHROPIC_API_KEY: 'sk-user-key' },
            stubPorts(),
        );
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
    });

    it('claude: user ANTHROPIC_BASE_URL + host key → forwards host key', async () => {
        const result = await resolveCredentials(
            'claude',
            { ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
            stubPorts({
                hostEnv: (k) => k === 'ANTHROPIC_API_KEY' ? 'sk-host-key' : undefined,
            }),
        );
        expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-host-key' });
    });

    it('claude: user ANTHROPIC_BASE_URL + no host key → throws', async () => {
        await expect(
            resolveCredentials(
                'claude',
                { ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
                stubPorts(),
            ),
        ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });

    it('claude: no user env + Keychain available (macOS) → Keychain token', async () => {
        const result = await resolveCredentials(
            'claude',
            {},
            stubPorts({
                platform: 'darwin',
                readKeychainToken: async () => 'oauth-token-123',
            }),
        );
        expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'oauth-token-123' });
    });

    it('claude: no user env + no Keychain + host key → forwards host key', async () => {
        const result = await resolveCredentials(
            'claude',
            {},
            stubPorts({
                hostEnv: (k) => ({ ANTHROPIC_API_KEY: 'sk-host', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }[k]),
            }),
        );
        expect(result.env).toEqual({
            ANTHROPIC_API_KEY: 'sk-host',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        });
    });

    it('claude: no user env + nothing → empty', async () => {
        const result = await resolveCredentials('claude', {}, stubPorts());
        expect(result.env).toEqual({});
    });

    it('claude: host ANTHROPIC_BASE_URL + host key + darwin keychain → forwards host, skips keychain', async () => {
        // A proxy at the host level (e.g. custom API gateway) is incompatible with
        // the direct-Anthropic OAuth token from Keychain. When host signals
        // proxy intent via ANTHROPIC_BASE_URL, host creds must win over Keychain.
        const result = await resolveCredentials(
            'claude',
            {},
            stubPorts({
                platform: 'darwin',
                hostEnv: (k) => ({
                    ANTHROPIC_API_KEY: 'hosted-sk',
                    ANTHROPIC_BASE_URL: 'https://proxy.example.com',
                }[k]),
                readKeychainToken: async () => 'sk-ant-oat01-keychain-token',
            }),
        );
        expect(result.env).toEqual({
            ANTHROPIC_API_KEY: 'hosted-sk',
            ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        });
    });

    it('claude: unrelated OPENAI_API_KEY does not skip Keychain', async () => {
        const result = await resolveCredentials(
            'claude',
            { OPENAI_API_KEY: 'sk-openai' },
            stubPorts({
                platform: 'darwin',
                readKeychainToken: async () => 'oauth-from-keychain',
            }),
        );
        expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'oauth-from-keychain' });
    });

    it('claude: user both ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL → empty', async () => {
        const result = await resolveCredentials(
            'claude',
            { ANTHROPIC_API_KEY: 'sk-mine', ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
            stubPorts(),
        );
        expect(result.env).toEqual({});
    });

    // --- Codex scenarios ---

    it('codex: user OPENAI_API_KEY → empty env + setup command', async () => {
        const result = await resolveCredentials(
            'codex',
            { OPENAI_API_KEY: 'sk-test' },
            stubPorts(),
        );
        expect(result.env).toEqual({});
        expect(result.setupCommands).toHaveLength(1);
        expect(result.setupCommands[0]).toContain('codex login');
        expect(result.copyFromHome).toEqual([]);
    });

    it('codex: no user env + host key → forwards key + setup command', async () => {
        const result = await resolveCredentials(
            'codex',
            {},
            stubPorts({
                hostEnv: (k) => k === 'OPENAI_API_KEY' ? 'sk-host-openai' : undefined,
            }),
        );
        expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-host-openai' });
        expect(result.setupCommands).toHaveLength(1);
        expect(result.setupCommands[0]).toContain('codex login');
    });

    it('codex: user OPENAI_BASE_URL + host key → forwards host key', async () => {
        const result = await resolveCredentials(
            'codex',
            { OPENAI_BASE_URL: 'https://openai-proxy.example.com' },
            stubPorts({
                hostEnv: (k) => k === 'OPENAI_API_KEY' ? 'sk-host-openai' : undefined,
            }),
        );
        expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-host-openai' });
        expect(result.setupCommands).toEqual([]);
    });

    it('codex: user OPENAI_BASE_URL + no host key → throws', async () => {
        await expect(
            resolveCredentials(
                'codex',
                { OPENAI_BASE_URL: 'https://openai-proxy.example.com' },
                stubPorts(),
            ),
        ).rejects.toThrow(/OPENAI_API_KEY/);
    });

    it('codex: no keys + cached auth.json → copyFromHome', async () => {
        const result = await resolveCredentials(
            'codex',
            {},
            stubPorts({
                homedir: '/home/test',
                fileExists: async (p) => p === '/home/test/.codex/auth.json',
            }),
        );
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual(['.codex/auth.json']);
    });

    it('codex: no keys + no cache → empty', async () => {
        const result = await resolveCredentials('codex', {}, stubPorts());
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
    });

    // --- Cursor scenarios ---

    it('cursor: user-provided CURSOR_API_KEY → pass-through empty env (user intent trusted)', async () => {
        const result = await resolveCredentials(
            'cursor',
            { CURSOR_API_KEY: 'user-cursor-key' },
            stubPorts(),
        );
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
    });

    it('cursor: user CURSOR_API_BASE_URL + host CURSOR_API_KEY → forwards host key', async () => {
        const result = await resolveCredentials(
            'cursor',
            { CURSOR_API_BASE_URL: 'https://proxy.example.com' },
            stubPorts({
                hostEnv: (k) => k === 'CURSOR_API_KEY' ? 'host-cursor-key' : undefined,
            }),
        );
        expect(result.env).toEqual({ CURSOR_API_KEY: 'host-cursor-key' });
    });

    it('cursor: user CURSOR_API_BASE_URL + no host key → throws', async () => {
        await expect(
            resolveCredentials(
                'cursor',
                { CURSOR_API_BASE_URL: 'https://proxy.example.com' },
                stubPorts(),
            ),
        ).rejects.toThrow(/CURSOR_API_KEY/);
    });

    it('cursor: no user env + host CURSOR_API_KEY + host CURSOR_API_BASE_URL → forwards both', async () => {
        const result = await resolveCredentials(
            'cursor',
            {},
            stubPorts({
                hostEnv: (k) => ({
                    CURSOR_API_KEY: 'host-key',
                    CURSOR_API_BASE_URL: 'https://api2.cursor.sh',
                }[k]),
            }),
        );
        expect(result.env).toEqual({
            CURSOR_API_KEY: 'host-key',
            CURSOR_API_BASE_URL: 'https://api2.cursor.sh',
        });
    });

    it('cursor: user provides both CURSOR_API_KEY and CURSOR_API_BASE_URL → empty', async () => {
        const result = await resolveCredentials(
            'cursor',
            { CURSOR_API_KEY: 'user-key', CURSOR_API_BASE_URL: 'https://proxy.example.com' },
            stubPorts(),
        );
        expect(result.env).toEqual({});
    });

    it('cursor: neither user nor host set on non-darwin → throws (OAuth unsupported)', async () => {
        await expect(
            resolveCredentials('cursor', {}, stubPorts()),
        ).rejects.toThrow(/CURSOR_API_KEY is not set/);
    });

    it('cursor: neither user nor host set on darwin + logged in → links host keychain', async () => {
        const result = await resolveCredentials(
            'cursor',
            {},
            stubPorts({ platform: 'darwin', keychainEntryExists: async () => true }),
        );
        expect(result.env).toEqual({});
        expect(result.setupCommands).toEqual([]);
        expect(result.copyFromHome).toEqual([]);
        expect(result.linkFromHome).toEqual(['Library/Keychains']);
    });

    it('cursor: neither user nor host set on darwin + not logged in → throws with login hint', async () => {
        await expect(
            resolveCredentials(
                'cursor',
                {},
                stubPorts({ platform: 'darwin', keychainEntryExists: async () => false }),
            ),
        ).rejects.toThrow(/cursor-agent login/);
    });

    it('cursor: keychain probe queries the cursor-access-token / cursor-user entry', async () => {
        const probedCalls: Array<[string, string]> = [];
        await resolveCredentials(
            'cursor',
            {},
            stubPorts({
                platform: 'darwin',
                keychainEntryExists: async (service, account) => {
                    probedCalls.push([service, account]);
                    return true;
                },
            }),
        );
        expect(probedCalls).toEqual([['cursor-access-token', 'cursor-user']]);
    });

    it('cursor: host CURSOR_API_KEY set on darwin → forwards key, no keychain link', async () => {
        const result = await resolveCredentials(
            'cursor',
            {},
            stubPorts({
                platform: 'darwin',
                hostEnv: (k) => k === 'CURSOR_API_KEY' ? 'host-key' : undefined,
            }),
        );
        expect(result.env).toEqual({ CURSOR_API_KEY: 'host-key' });
        expect(result.linkFromHome ?? []).toEqual([]);
    });
});
