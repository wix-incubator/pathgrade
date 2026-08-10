import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginCodexAppServerWithApiKey } from '../src/agents/codex-app-server/agent.js';
import { collectClaudeSdkMessages } from '../src/agents/claude.js';

type Provider = 'claude' | 'codex';
type ProviderResult = {
    id: string;
    provider: Provider;
    status: 'pass' | 'fail' | 'skipped';
    skipped: 0 | 1;
    report?: any;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const missingCredential = '__PATHGRADE_TEST_MISSING_CREDENTIAL__';
const isGateChild = process.env.PATHGRADE_LIVE_GATE_CHILD === '1';
const temporaryDirectories: string[] = [];
const gate = readGate(process.env);
const results = new Map<Provider, ProviderResult>();

for (const provider of ['claude', 'codex'] as const) {
    const selected = gate.selected.includes(provider);
    results.set(provider, {
        id: `${process.platform === 'darwin' ? 'macos' : 'linux'}-${provider}`,
        provider,
        status: selected && gate.enabled ? 'fail' : 'skipped',
        skipped: selected && gate.enabled ? 0 : 1,
    });
}

describe('packed standalone live runtimes', () => {
    it.skipIf(!shouldRun('claude'))('runs one Claude turn with bundled provenance and no credential leak', async () => {
        await runLiveProvider('claude');
    }, 360_000);

    it.skipIf(!shouldRun('codex'))('runs one Codex app-server turn with isolated API-key login and no credential leak', async () => {
        await runLiveProvider('codex');
    }, 360_000);
});

if (!isGateChild) describe('live-smoke gate contract', () => {
    it('snapshots unexpected empty directories with their entry type', () => {
        const target = makeTempDir('pathgrade-target-tree-');
        const baseline = snapshotTree(target);
        fs.mkdirSync(path.join(target, 'unexpected-empty'));
        expect(snapshotTree(target).get('unexpected-empty')).toEqual({ type: 'directory' });
        expect(() => assertExactTargetTree(target, baseline, new Map())).toThrow();
    });

    it.skipIf(process.platform === 'win32')('snapshots unexpected symlinks and their target', () => {
        const target = makeTempDir('pathgrade-target-tree-');
        const baseline = snapshotTree(target);
        fs.symlinkSync('missing-target', path.join(target, 'unexpected-link'));
        expect(snapshotTree(target).get('unexpected-link')).toEqual({
            type: 'symlink', target: 'missing-target',
        });
        expect(() => assertExactTargetTree(target, baseline, new Map())).toThrow();
    });

    it('redacts deterministic injected login and query failures at the provider boundaries', async () => {
        const secret = 'pathgrade-live-redaction-sentinel';
        const codexCalls: Array<{ method: string; params: unknown }> = [];
        const transport = {
            sendRequest: async (method: string, params: unknown) => {
                codexCalls.push({ method, params });
                throw new Error(`login sentinel Authorization: Bearer ${secret}`);
            },
        } as any;
        const loginError = await loginCodexAppServerWithApiKey(transport, secret).catch(error => error);
        expect(loginError.message).toContain('login sentinel');
        expect(loginError.message).not.toContain(secret);
        expect(codexCalls.map(call => call.method)).toEqual(['account/login/start']);

        const queryArgs: unknown[] = [];
        const failingQuery = (args: unknown) => {
            queryArgs.push(args);
            return {
                [Symbol.asyncIterator]() { return this; },
                async next() { throw new Error(`query sentinel _auth=${secret}`); },
            } as any;
        };
        const queryError = await collectClaudeSdkMessages(
            failingQuery as any, { prompt: 'safe prompt', options: {} }, [secret],
        ).catch(error => error);
        expect(queryError.message).toContain('query sentinel');
        expect(queryError.message).not.toContain(secret);
        expect(String(queryError.cause ?? '')).not.toContain(secret);
        expect(queryArgs).toHaveLength(1);

        const surfaces = {
            errors: [loginError.message, queryError.message], command_args: ['standalone', 'run', 'live.eval.ts'],
            stdout: '', stderr: '', report: { status: 'fail', diagnostic: queryError.message },
            snapshot: JSON.stringify(codexCalls.map(call => call.method)), debug: queryError.message,
        };
        expect(JSON.stringify(surfaces)).not.toContain(secret);
    });

    it('exits zero with exactly two skipped paid cases when live flags are unset', () => {
        const result = runGateChild({});

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            numFailedTests: 0,
            numPendingTests: 2,
            numPassedTests: 0,
        });
    });

    it('hard-fails protected mode for each missing retained-artifact prerequisite', () => {
        const fixture = makeFakeTarball();
        const common = {
            PATHGRADE_REQUIRE_LIVE_SMOKE: '1',
            PATHGRADE_STANDALONE_LIVE_SMOKE: '1',
            PATHGRADE_STANDALONE_LIVE_PROVIDER: 'codex',
            OPENAI_API_KEY: 'pathgrade-gate-contract-key',
        };

        expectRejected(runGateChild({ PATHGRADE_REQUIRE_LIVE_SMOKE: '1' }), 'enable flag');
        expectRejected(runGateChild({
            ...common,
            PATHGRADE_STANDALONE_TARBALL: undefined,
            PATHGRADE_STANDALONE_TARBALL_SHA512: fixture.sha512,
        }), 'retained tarball');
        expectRejected(runGateChild({
            ...common,
            PATHGRADE_STANDALONE_TARBALL: fixture.filename,
            PATHGRADE_STANDALONE_TARBALL_SHA512: undefined,
        }), 'expected SHA-512');
        expectRejected(runGateChild({
            ...common,
            PATHGRADE_STANDALONE_TARBALL: fixture.filename,
            PATHGRADE_STANDALONE_TARBALL_SHA512: '0'.repeat(128),
        }), 'SHA-512 mismatch');
    });

    it('does not let one provider credential satisfy the other protected gate', () => {
        const fixture = makeFakeTarball();
        const retained = {
            PATHGRADE_REQUIRE_LIVE_SMOKE: '1',
            PATHGRADE_STANDALONE_LIVE_SMOKE: '1',
            PATHGRADE_STANDALONE_TARBALL: fixture.filename,
            PATHGRADE_STANDALONE_TARBALL_SHA512: fixture.sha512,
        };

        expectRejected(runGateChild({
            ...retained,
            PATHGRADE_STANDALONE_LIVE_PROVIDER: 'claude',
            PATHGRADE_LIVE_GATE_MASK_CREDENTIAL: 'claude',
            OPENAI_API_KEY: 'codex-only-key',
        }), 'Claude credential');
        expectRejected(runGateChild({
            ...retained,
            PATHGRADE_STANDALONE_LIVE_PROVIDER: 'codex',
            PATHGRADE_LIVE_GATE_MASK_CREDENTIAL: 'codex',
            ANTHROPIC_API_KEY: 'claude-only-key',
        }), 'OPENAI_API_KEY');
    });

    it('forwards only the selected provider base URL into the isolated live run', () => {
        const installation = {
            home: '/isolated/home',
            codexHome: '/isolated/codex',
            cache: '/isolated/cache',
            temporary: '/isolated/tmp',
            shims: '/isolated/shims',
            debugDir: '/isolated/debug',
        } as ReturnType<typeof createInstallation>;
        const hostEnv = {
            PATH: '/host/bin',
            ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
            OPENAI_BASE_URL: 'https://openai.example.test/v1',
        };
        const claude = liveEnvironment('claude', installation, 'claude-key', hostEnv);
        const codex = liveEnvironment('codex', installation, 'codex-key', hostEnv);
        expect(claude).toMatchObject({
            ANTHROPIC_API_KEY: 'claude-key',
            ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
        });
        expect(claude.OPENAI_BASE_URL).toBe('');
        expect(codex).toMatchObject({
            OPENAI_API_KEY: 'codex-key',
            OPENAI_BASE_URL: 'https://openai.example.test/v1',
        });
        expect(codex.ANTHROPIC_BASE_URL).toBe('');
    });
});

afterEach(() => {
    cleanupTemporaryDirectories();
});

afterAll(() => {
    if (!gate.required && !process.env.PATHGRADE_LIVE_EVIDENCE_FILE) return;
    const providers = [...results.values()];
    const summary = {
        schema: 'pathgrade-live-evidence/v1',
        status: providers.every(result => (
            !gate.selected.includes(result.provider) || (result.status === 'pass' && result.skipped === 0)
        )) ? 'pass' : 'fail',
        selected: gate.selected,
        passed: providers.filter(result => result.status === 'pass').length,
        skipped: providers.filter(result => result.skipped === 1).length,
        providers,
        tarball: gate.tarball,
        tarball_sha512: gate.sha512,
        source_commit: process.env.GITHUB_SHA ?? null,
        runtime_environment: {
            platform: process.platform, arch: process.arch,
            node_major: Number(process.versions.node.split('.')[0]),
        },
    };
    if (process.env.PATHGRADE_LIVE_EVIDENCE_FILE) {
        fs.writeFileSync(process.env.PATHGRADE_LIVE_EVIDENCE_FILE, JSON.stringify(summary, null, 2));
    }
    process.stdout.write(`PATHGRADE_LIVE_SUMMARY=${JSON.stringify(summary)}\n`);
    if (gate.required && summary.status !== 'pass') process.exitCode = 1;
});

async function runLiveProvider(provider: Provider): Promise<void> {
    const secret = credential(provider);
    const installation = createInstallation(provider);
    const liveRun = invokeStandalone(installation, liveEnvironment(provider, installation, secret));
    try {
        expect(liveRun.status, `${liveRun.stdout}\n${liveRun.stderr}`).toBe(0);
        const reportPath = path.join(installation.target, '.pathgrade/results.json');
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assertReport(provider, report);
        assertSecretAbsent(secret, liveRun, installation.target, installation.debugDir);
        assertTargetIsolation(installation, secret);
        expect(readShimCalls(installation.shims)).toBe('');
        results.set(provider, {
            ...results.get(provider)!,
            status: 'pass',
            skipped: 0,
            report,
        });
    } catch (error) {
        results.set(provider, { ...results.get(provider)!, status: 'fail', skipped: 0 });
        throw error;
    }
}

function createInstallation(provider: Provider) {
    const prefix = makeTempDir('pathgrade-live-prefix-');
    const target = makeTempDir('pathgrade-live-target-');
    const home = makeTempDir('pathgrade-live-home-');
    const codexHome = makeTempDir('pathgrade-live-codex-home-');
    const cache = makeTempDir('pathgrade-live-cache-');
    const temporary = makeTempDir('pathgrade-live-tmp-');
    const debugDir = makeTempDir('pathgrade-live-debug-');
    const shims = makeTempDir('pathgrade-live-shims-');
    createFailingShims(shims);
    const install = spawnSync('npm', [
        'install', '--global', '--prefix', prefix, '--ignore-scripts', gate.tarball!,
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, npm_config_cache: cache } });
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    fs.writeFileSync(path.join(target, '.env'), 'PATHGRADE_LIVE_ENV_SENTINEL=must-not-load\n');
    fs.writeFileSync(path.join(target, 'live.eval.ts'), liveEvalSource(provider));
    const baseline = snapshotTree(target);
    return { provider, prefix, target, home, codexHome, cache, temporary, debugDir, shims, baseline };
}

function liveEnvironment(
    provider: Provider,
    installation: ReturnType<typeof createInstallation>,
    secret: string,
    hostEnv: NodeJS.ProcessEnv = process.env,
) {
    const env = {
        ...withoutHostCredentials(hostEnv),
        HOME: installation.home,
        CODEX_HOME: installation.codexHome,
        XDG_CACHE_HOME: installation.cache,
        npm_config_cache: installation.cache,
        TMPDIR: installation.temporary,
        PATH: `${installation.shims}${path.delimiter}${hostEnv.PATH ?? ''}`,
        PATHGRADE_LIVE_DEBUG_DIR: installation.debugDir,
        PATHGRADE_LIVE_PROVIDER_CASE: provider,
    };
    if (provider === 'claude') {
        return {
            ...env,
            ANTHROPIC_API_KEY: secret,
            ...(hostEnv.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: hostEnv.ANTHROPIC_BASE_URL } : {}),
        };
    }
    return {
        ...env,
        OPENAI_API_KEY: secret,
        ...(hostEnv.OPENAI_BASE_URL ? { OPENAI_BASE_URL: hostEnv.OPENAI_BASE_URL } : {}),
    };
}

function invokeStandalone(installation: ReturnType<typeof createInstallation>, env: NodeJS.ProcessEnv) {
    return spawnSync(
        path.join(installation.prefix, 'bin', 'pathgrade'),
        ['standalone', 'run', 'live.eval.ts'],
        { cwd: installation.target, env, encoding: 'utf8', timeout: 300_000 },
    );
}

function assertReport(provider: Provider, report: any) {
    expect(report).toMatchObject({
        version: 1,
        status: 'pass',
        provenance: {
            mode: 'standalone',
            runtimes: {
                claude: { sdk_version: '0.2.116', claude_code_version: '2.1.116' },
                codex: { package_version: '0.144.0', native_version: '0.144.0' },
            },
        },
    });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].trials).toHaveLength(1);
    expect(report.groups[0].trials[0].reward).toBe(1);
    const provenance = report.groups[0].trials[0].agent_provenance;
    if (provider === 'claude') {
        expect(provenance).toEqual({
            agent: 'claude',
            transport: 'native',
            model: { id: null, source: 'provider-default' },
            authentication: 'api-key',
            runtime: {
                package: '@anthropic-ai/claude-agent-sdk',
                package_version: '0.2.116',
                embedded_binary_version: '2.1.116',
                provenance: 'bundled',
            },
        });
    } else {
        expect(provenance).toEqual({
            agent: 'codex',
            transport: 'app-server',
            model: { id: 'gpt-5.4', source: 'pathgrade-default' },
            authentication: 'api-key',
            runtime: {
                package: '@openai/codex',
                package_version: '0.144.0',
                embedded_binary_version: '0.144.0',
                provenance: 'bundled',
            },
        });
    }
}

function assertSecretAbsent(secret: string, run: ReturnType<typeof spawnSync>, target: string, debugDir: string) {
    const output = `${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`;
    expect(output).not.toContain(secret);
    for (const root of [path.join(target, '.pathgrade'), debugDir]) {
        if (!fs.existsSync(root)) continue;
        for (const filename of filesBelow(root)) {
            expect(fs.readFileSync(filename, 'utf8')).not.toContain(secret);
        }
    }
}

function assertTargetIsolation(installation: ReturnType<typeof createInstallation>, secret: string) {
    const { target, baseline, provider, debugDir } = installation;
    const expectedCreated = new Map<string, TreeEntry>([
        ['.pathgrade', { type: 'directory' }],
        ['.pathgrade/.gitignore', { type: 'file' }],
        ['.pathgrade/results.json', { type: 'file' }],
        ['.pathgrade/traces', { type: 'directory' }],
        [`.pathgrade/traces/live-eval-ts-packed-${provider}-live-smoke.json`, { type: 'file' }],
    ]);
    const createdFiles = assertExactTargetTree(target, baseline, expectedCreated);
    for (const filename of [...createdFiles, ...filesBelow(debugDir)]) {
        const contents = fs.readFileSync(filename, 'utf8');
        expect(contents, `${filename} leaked the credential`).not.toContain(secret);
        expect(contents, `${filename} loaded the target .env`).not.toContain('must-not-load');
    }
}

type TreeEntry =
    | { type: 'file'; sha512?: string }
    | { type: 'directory' }
    | { type: 'symlink'; target: string }
    | { type: 'socket' }
    | { type: 'other' };

function snapshotTree(directory: string) {
    const entries = new Map<string, TreeEntry>();
    const visit = (current: string) => {
        for (const name of fs.readdirSync(current)) {
            const filename = path.join(current, name);
            const relative = path.relative(directory, filename);
            const stat = fs.lstatSync(filename);
            if (stat.isFile()) entries.set(relative, { type: 'file', sha512: sha512File(filename) });
            else if (stat.isDirectory()) {
                entries.set(relative, { type: 'directory' });
                visit(filename);
            } else if (stat.isSymbolicLink()) entries.set(relative, { type: 'symlink', target: fs.readlinkSync(filename) });
            else if (stat.isSocket()) entries.set(relative, { type: 'socket' });
            else entries.set(relative, { type: 'other' });
        }
    };
    visit(directory);
    return entries;
}

function assertExactTargetTree(
    target: string,
    baseline: Map<string, TreeEntry>,
    expectedCreated: Map<string, TreeEntry>,
) {
    const after = snapshotTree(target);
    for (const [filename, entry] of baseline) expect(after.get(filename), `${filename} changed`).toEqual(entry);
    const created = new Map([...after].filter(([filename]) => !baseline.has(filename)));
    expect([...created.keys()].sort(), 'target contains unexpected entries').toEqual([...expectedCreated.keys()].sort());
    for (const [filename, expected] of expectedCreated) {
        const actual = created.get(filename);
        expect(actual?.type, `${filename} has unexpected entry type`).toBe(expected.type);
        if (expected.type === 'symlink') expect(actual).toEqual(expected);
    }
    return [...created]
        .filter(([, entry]) => entry.type === 'file')
        .map(([filename]) => path.join(target, filename));
}

function liveEvalSource(provider: Provider) {
    return `import { describe, expect, it } from 'vitest';
import { check, createAgent, evaluate } from '@wix/pathgrade';
describe('packed ${provider} live smoke', () => {
  it('completes one paid turn', async () => {
    expect(process.env.PATHGRADE_LIVE_ENV_SENTINEL).toBeUndefined();
    const agent = await createAgent({ agent: '${provider}', ${provider === 'codex' ? "transport: 'app-server', " : ''}timeout: 180, debug: process.env.PATHGRADE_LIVE_DEBUG_DIR });
    const response = await agent.prompt('Reply briefly with the word ready. Do not use tools.');
    const result = await evaluate(agent, [check('provider returned a response', () => response.trim().length > 0)]);
    expect(result.score).toBe(1);
  });
});
`;
}

function readGate(env: NodeJS.ProcessEnv) {
    const enabled = env.PATHGRADE_STANDALONE_LIVE_SMOKE === '1';
    const required = env.PATHGRADE_REQUIRE_LIVE_SMOKE === '1';
    const provider = env.PATHGRADE_STANDALONE_LIVE_PROVIDER || 'all';
    if (provider !== 'all' && provider !== 'claude' && provider !== 'codex') {
        throw new Error(`PATHGRADE_STANDALONE_LIVE_PROVIDER must be claude, codex, or all; got ${provider}`);
    }
    const selected: Provider[] = provider === 'all' ? ['claude', 'codex'] : [provider];
    if (required && !enabled) throw new Error('protected live smoke requires enable flag PATHGRADE_STANDALONE_LIVE_SMOKE=1');
    const maskedCredential = env.PATHGRADE_LIVE_GATE_MASK_CREDENTIAL;
    if (required && selected.includes('claude') && (maskedCredential === 'claude' || !hasCredential(env.ANTHROPIC_API_KEY))) {
        throw new Error('protected Claude credential ANTHROPIC_API_KEY is missing');
    }
    if (required && selected.includes('codex') && (maskedCredential === 'codex' || !hasCredential(env.OPENAI_API_KEY))) {
        throw new Error('protected Codex credential OPENAI_API_KEY is missing');
    }
    const tarball = env.PATHGRADE_STANDALONE_TARBALL;
    const sha512 = env.PATHGRADE_STANDALONE_TARBALL_SHA512;
    if (required && (!tarball || !path.isAbsolute(tarball) || !tarball.endsWith('.tgz') || !fs.existsSync(tarball))) {
        throw new Error('protected live smoke retained tarball must be an existing absolute .tgz path');
    }
    if (required && (!sha512 || !/^[a-f\d]{128}$/i.test(sha512))) {
        throw new Error('protected live smoke expected SHA-512 is missing or invalid');
    }
    if (required && sha512File(tarball!) !== sha512) throw new Error('protected live smoke tarball SHA-512 mismatch');
    return { enabled, required, selected, tarball, sha512 };
}

function shouldRun(provider: Provider) {
    if (!gate.enabled || !gate.selected.includes(provider)) return false;
    if (!gate.required) {
        if (!gate.tarball || !gate.sha512 || !path.isAbsolute(gate.tarball) || !fs.existsSync(gate.tarball)) return false;
        if (provider === 'claude' && !hasCredential(process.env.ANTHROPIC_API_KEY)) return false;
        if (provider === 'codex' && !hasCredential(process.env.OPENAI_API_KEY)) return false;
    }
    return true;
}

function credential(provider: Provider) {
    return provider === 'claude' ? process.env.ANTHROPIC_API_KEY! : process.env.OPENAI_API_KEY!;
}

function runGateChild(overrides: Record<string, string | undefined>) {
    const env = withoutLiveEnvironment(process.env);
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) env[key] = '';
        else env[key] = value;
    }
    env.PATHGRADE_LIVE_GATE_CHILD = '1';
    return spawnSync(process.execPath, [
        path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run', path.join(repoRoot, 'tests/standalone-live-smoke.test.ts'), '--reporter=json', '--silent',
    ], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60_000 });
}

function expectRejected(result: ReturnType<typeof spawnSync>, diagnostic: string) {
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(diagnostic);
}

function makeFakeTarball() {
    const directory = makeTempDir('pathgrade-live-gate-');
    const filename = path.join(directory, 'retained.tgz');
    fs.writeFileSync(filename, 'gate contract only');
    return { filename, sha512: sha512File(filename) };
}

function withoutLiveEnvironment(env: NodeJS.ProcessEnv) {
    const result = withoutHostCredentials(env);
    for (const key of Object.keys(result)) {
        if (key.startsWith('PATHGRADE_STANDALONE_LIVE_') || key.startsWith('PATHGRADE_REQUIRE_LIVE_') || key === 'PATHGRADE_LIVE_EVIDENCE_FILE') {
            delete result[key];
        }
    }
    for (const key of [
        'PATHGRADE_STANDALONE_LIVE_SMOKE',
        'PATHGRADE_REQUIRE_LIVE_SMOKE',
        'PATHGRADE_STANDALONE_LIVE_PROVIDER',
        'PATHGRADE_STANDALONE_TARBALL',
        'PATHGRADE_STANDALONE_TARBALL_SHA512',
        'PATHGRADE_LIVE_EVIDENCE_FILE',
    ]) result[key] = '';
    return result;
}

function withoutHostCredentials(env: NodeJS.ProcessEnv) {
    const result = { ...env };
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) result[key] = missingCredential;
    for (const key of [
        'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL',
        'OPENAI_BASE_URL', 'CURSOR_API_KEY', 'CURSOR_API_BASE_URL',
        'PATHGRADE_CLAUDE_CODE_EXECUTABLE', 'PATHGRADE_CODEX_TRANSPORT',
    ]) result[key] = '';
    return result;
}

function hasCredential(value: string | undefined) {
    return Boolean(value && value !== missingCredential);
}

function createFailingShims(directory: string) {
    for (const command of ['claude', 'codex', 'vitest']) {
        const filename = path.join(directory, command);
        fs.writeFileSync(filename, `#!/bin/sh\necho ${command} >> "${path.join(directory, 'calls')}"\nexit 97\n`);
        fs.chmodSync(filename, 0o755);
    }
}

function readShimCalls(directory: string) {
    const filename = path.join(directory, 'calls');
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
}

function filesBelow(directory: string): string[] {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name));
}

function sha512File(filename: string) {
    return createHash('sha512').update(fs.readFileSync(filename)).digest('hex');
}

function makeTempDir(prefix: string) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function cleanupTemporaryDirectories() {
    for (const directory of temporaryDirectories.splice(0).reverse()) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
