import { readFile } from 'node:fs/promises';
import { verifyBundledClaudeRuntime } from '../agents/claude-runtime.js';
import { resolveBundledCodexCommand, verifyBundledCodexRuntime } from '../agents/codex-runtime.js';
import { resolveBundledVitestCli } from './vitest-invocation.js';

export const STANDALONE_PROVENANCE_ENV = 'PATHGRADE_STANDALONE_PROVENANCE' as const;

export interface StandaloneRunProvenance {
    mode: 'standalone';
    package_version: string;
    vitest_version: string;
    runtimes: {
        claude: {
            sdk_version: string;
            claude_code_version: string;
        };
        codex: {
            package_version: string;
            native_version: string;
        };
    };
    platform: {
        os: NodeJS.Platform;
        arch: string;
        node: string;
    };
}

export async function buildStandaloneRunProvenance(): Promise<StandaloneRunProvenance> {
    const [packageVersion, vitest, claude, codex] = await Promise.all([
        readPathgradePackageVersion(),
        Promise.resolve(resolveBundledVitestCli()),
        verifyBundledClaudeRuntime(),
        verifyBundledCodexRuntime(resolveBundledCodexCommand()),
    ]);

    return {
        mode: 'standalone',
        package_version: packageVersion,
        vitest_version: vitest.version,
        runtimes: {
            claude: {
                sdk_version: claude.sdkVersion,
                claude_code_version: claude.embeddedBinaryVersion,
            },
            codex: {
                package_version: codex.packageVersion,
                native_version: codex.nativeVersion,
            },
        },
        platform: { os: process.platform, arch: process.arch, node: process.version },
    };
}

export function encodeStandaloneRunProvenance(provenance: StandaloneRunProvenance): string {
    return Buffer.from(JSON.stringify(provenance), 'utf8').toString('base64url');
}

export function readStandaloneRunProvenance(
    env: NodeJS.ProcessEnv = process.env,
): StandaloneRunProvenance {
    const encoded = env[STANDALONE_PROVENANCE_ENV];
    if (!encoded) throw packagingDefect('provenance payload is missing');
    try {
        const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
        if (!isStandaloneRunProvenance(parsed)) throw new Error('invalid shape');
        return parsed;
    } catch {
        throw packagingDefect('provenance payload is invalid');
    }
}

async function readPathgradePackageVersion(): Promise<string> {
    try {
        const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
        if (typeof packageJson.version !== 'string') throw new Error('missing version');
        return packageJson.version;
    } catch {
        throw packagingDefect('package metadata is unreadable');
    }
}

function isStandaloneRunProvenance(value: unknown): value is StandaloneRunProvenance {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const runtimes = record.runtimes as Record<string, unknown> | undefined;
    const platform = record.platform as Record<string, unknown> | undefined;
    const claude = runtimes?.claude as Record<string, unknown> | undefined;
    const codex = runtimes?.codex as Record<string, unknown> | undefined;
    return record.mode === 'standalone'
        && typeof record.package_version === 'string'
        && typeof record.vitest_version === 'string'
        && typeof claude?.sdk_version === 'string'
        && typeof claude?.claude_code_version === 'string'
        && typeof codex?.package_version === 'string'
        && typeof codex?.native_version === 'string'
        && typeof platform?.os === 'string'
        && typeof platform?.arch === 'string'
        && typeof platform?.node === 'string';
}

function packagingDefect(message: string): Error {
    return new Error(`pathgrade standalone: invalid provenance payload; this is a Pathgrade packaging defect (${message})`);
}
