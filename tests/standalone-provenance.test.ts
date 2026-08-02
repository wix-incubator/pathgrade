import { describe, expect, it } from 'vitest';
import {
    buildStandaloneRunProvenance,
    encodeStandaloneRunProvenance,
    readStandaloneRunProvenance,
    STANDALONE_PROVENANCE_ENV,
} from '../src/standalone/provenance.js';
import { resolveCredentials } from '../src/providers/credentials.js';

describe('standalone run provenance', () => {
    it('builds the exact bundled package and platform manifest', async () => {
        await expect(buildStandaloneRunProvenance()).resolves.toMatchObject({
            mode: 'standalone',
            package_version: '1.0.1',
            vitest_version: '4.1.7',
            runtimes: {
                claude: {
                    sdk_version: '0.2.116',
                    claude_code_version: '2.1.116',
                },
                codex: {
                    package_version: '0.144.0',
                    native_version: '0.144.0',
                },
            },
            platform: {
                os: process.platform,
                arch: process.arch,
                node: process.version,
            },
        });
    });

    it('round-trips base64url provenance and rejects malformed worker values', async () => {
        const provenance = await buildStandaloneRunProvenance();
        const encoded = encodeStandaloneRunProvenance(provenance);

        expect(STANDALONE_PROVENANCE_ENV).toBe('PATHGRADE_STANDALONE_PROVENANCE');
        expect(readStandaloneRunProvenance({ [STANDALONE_PROVENANCE_ENV]: encoded })).toEqual(provenance);
        expect(() => readStandaloneRunProvenance({
            [STANDALONE_PROVENANCE_ENV]: `${encoded}!`,
        })).toThrow(/pathgrade standalone: invalid provenance payload; this is a Pathgrade packaging defect/);
        expect(() => readStandaloneRunProvenance({ [STANDALONE_PROVENANCE_ENV]: 'not-provenance' })).toThrow(
            /pathgrade standalone: invalid provenance payload; this is a Pathgrade packaging defect/,
        );
    });

    it('accepts the workspace Claude OAuth marker in standalone mode', async () => {
        await expect(resolveCredentials(
            'claude',
            { PATHGRADE_CLAUDE_LOCAL_OAUTH: '1' },
            {
                hostEnv: key => key === 'ANTHROPIC_API_KEY' ? 'host-api-key' : undefined,
                platform: 'linux',
                homedir: () => '/tmp',
                readKeychainToken: async () => undefined,
                keychainEntryExists: async () => false,
                fileExists: async () => false,
            },
            { mode: 'standalone' },
        )).resolves.toEqual({ env: {}, setupCommands: [], copyFromHome: [] });
    });
});
