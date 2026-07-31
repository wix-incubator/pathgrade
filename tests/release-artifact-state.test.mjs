import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validator = path.join(repoRoot, 'scripts/release/verify-artifact-state.mjs');
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';

test('classifies a version absent from the public registry when no external staged evidence exists', () => {
    const result = runScenario({ public: null });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { state: 'absent', source: null, should_stage: true });
    assertOnlySupportedNpmReads(result.calls);
});

test('accepts a byte-identical public artifact only with verified semantic provenance', () => {
    const result = runScenario({ public: matchingMetadata(), publicEvidence: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { state: 'matching', source: 'public', should_stage: false });
    assert.match(result.calls, /^view /m);
    assert.match(result.calls, /^pack /m);
    assertOnlySupportedNpmReads(result.calls);
});

test('accepts externally verified staged evidence without invoking unsupported OIDC stage reads', () => {
    const result = runScenario({ public: null, stagedEvidence: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        state: 'matching', source: 'staged', stage_id: 'stage-123', should_stage: false,
    });
    assertOnlySupportedNpmReads(result.calls);
});

test('rejects wrong provenance subject digest, repository, workflow, commit, and predicate', () => {
    for (const [field, mutate] of [
        ['subject identity', e => { e.statement.subject[0].name = 'pkg:npm/attacker/pathgrade@1.0.1'; }],
        ['subject digest', e => { e.statement.subject[0].digest.sha512 = 'f'.repeat(128); }],
        ['repository', e => { e.statement.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/attacker/pathgrade'; }],
        ['workflow', e => { e.statement.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; }],
        ['source commit', e => { e.statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40); }],
        ['predicate', e => { e.statement.predicateType = 'https://slsa.dev/provenance/v0.2'; }],
    ]) {
        const result = runScenario({ public: matchingMetadata(), publicEvidence: true, mutateEvidence: mutate });
        assert.notEqual(result.status, 0, field);
        assert.match(result.stderr, new RegExp(field, 'i'));
    }
});

test('rejects conflicting public contents and missing verified provenance', () => {
    const contents = runScenario({ public: matchingMetadata(), publicEvidence: true, downloadedBytes: 'different' });
    assert.notEqual(contents.status, 0);
    assert.match(contents.stderr, /conflict.*contents/i);
    const provenance = runScenario({ public: matchingMetadata() });
    assert.notEqual(provenance.status, 0);
    assert.match(provenance.stderr, /verified provenance evidence/i);
});

test('redacts bearer, auth, token, and API-key values from npm view failures', () => {
    const secret = 'pathgrade-super-secret-value';
    const result = runScenario({
        publicError: `E500 Authorization: Bearer ${secret} npm_token=${secret} _auth=${secret}`,
        secret,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.match(result.stderr, /credential redacted/);
});

test('redacts secret-bearing process-start failures', () => {
    const secret = 'pathgrade-spawn-secret-value';
    const result = runScenario({ public: null, secret, missingCommand: secret });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.match(result.stderr, /could not start/);
});

function matchingMetadata() {
    return {
        name: '@wix/pathgrade', version: '1.0.1', gitHead: sourceCommit,
        dist: {
            integrity: '',
            attestations: {
                url: 'https://registry.npmjs.org/-/npm/v1/attestations/@wix%2fpathgrade@1.0.1',
                provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
            },
        },
    };
}

function provenanceEvidence(sha512) {
    return {
        schema: 'pathgrade-provenance-verification/v1',
        verification: {
            status: 'verified', verifier: 'npm-registry-sigstore',
            repository: 'wix-incubator/pathgrade', workflow: 'publish.yml', source_commit: sourceCommit,
            bundle_sha256: 'b'.repeat(64), rekor_log_index: 123456,
            certificate_identity: 'https://github.com/wix-incubator/pathgrade/.github/workflows/publish.yml@refs/tags/v1.0.1',
        },
        statement: {
            _type: 'https://in-toto.io/Statement/v1',
            predicateType: 'https://slsa.dev/provenance/v1',
            subject: [{ name: 'pkg:npm/%40wix/pathgrade@1.0.1', digest: { sha512 } }],
            predicate: {
                buildDefinition: {
                    buildType: 'https://actions.github.io/buildtypes/workflow/v1',
                    externalParameters: {
                        workflow: {
                            repository: 'https://github.com/wix-incubator/pathgrade',
                            path: '.github/workflows/publish.yml', ref: 'refs/tags/v1.0.1',
                        },
                    },
                    resolvedDependencies: [{
                        uri: 'git+https://github.com/wix-incubator/pathgrade@refs/tags/v1.0.1',
                        digest: { gitCommit: sourceCommit },
                    }],
                },
                runDetails: {
                    builder: {
                        id: 'https://github.com/wix-incubator/pathgrade/.github/workflows/publish.yml@refs/tags/v1.0.1',
                    },
                },
            },
        },
    };
}

function runScenario(scenario) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-artifact-state-'));
    try {
        const expected = path.join(directory, 'expected.tgz');
        const bytes = Buffer.from('canonical retained scoped tarball');
        fs.writeFileSync(expected, bytes);
        const sha512 = createHash('sha512').update(bytes).digest('hex');
        const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
        const normalized = JSON.parse(JSON.stringify(scenario, (_key, value) => typeof value === 'function' ? undefined : value));
        if (normalized.public?.dist) normalized.public.dist.integrity ||= integrity;
        normalized.downloadedBytes ??= bytes.toString('base64');
        normalized.downloadedBytesEncoding = scenario.downloadedBytes === undefined ? 'base64' : 'utf8';
        const scenarioFile = path.join(directory, 'scenario.json');
        fs.writeFileSync(scenarioFile, JSON.stringify(normalized));
        const calls = path.join(directory, 'calls.log');
        const fakeNpm = path.join(directory, 'fake-npm.mjs');
        fs.writeFileSync(fakeNpm, fakeNpmSource());
        fs.chmodSync(fakeNpm, 0o755);
        const args = [
            validator, '--package', '@wix/pathgrade', '--version', '1.0.1', '--tarball', expected,
            '--expected-sha512', sha512, '--source-commit', sourceCommit,
            '--npm-command', scenario.missingCommand ? path.join(directory, scenario.missingCommand) : fakeNpm,
        ];
        if (scenario.publicEvidence) {
            const evidence = provenanceEvidence(sha512);
            scenario.mutateEvidence?.(evidence);
            const filename = path.join(directory, 'public-evidence.json');
            fs.writeFileSync(filename, JSON.stringify(evidence));
            args.push('--attestation-evidence', filename);
        }
        if (scenario.stagedEvidence) {
            const stagedTarball = path.join(directory, 'staged.tgz');
            fs.writeFileSync(stagedTarball, bytes);
            const evidence = {
                schema: 'pathgrade-staged-verification/v1', status: 'verified', stage_id: 'stage-123',
                package: { ...matchingMetadata(), dist: { ...matchingMetadata().dist, integrity } },
                downloaded_tarball: path.basename(stagedTarball), tarball_sha512: sha512,
                standalone_smoke: { status: 'pass', tarball_sha512: sha512, rebuilt: false },
                provenance: provenanceEvidence(sha512),
            };
            const filename = path.join(directory, 'staged-evidence.json');
            fs.writeFileSync(filename, JSON.stringify(evidence));
            args.push('--staged-evidence', filename);
        }
        const result = spawnSync(process.execPath, args, {
            cwd: repoRoot, encoding: 'utf8',
            env: {
                ...process.env, FAKE_NPM_SCENARIO: scenarioFile, FAKE_NPM_CALLS: calls,
                OPENAI_API_KEY: scenario.secret ?? '', NPM_TOKEN: scenario.secret ?? '',
            },
        });
        return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function fakeNpmSource() {
    return `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); const s=JSON.parse(fs.readFileSync(process.env.FAKE_NPM_SCENARIO,'utf8'));
fs.appendFileSync(process.env.FAKE_NPM_CALLS,args.join(' ')+'\\n');
if(args[0]==='view') { if(s.publicError){process.stderr.write(s.publicError);process.exit(1)} if(!s.public){process.stderr.write('E404 Not Found\\n');process.exit(1)} process.stdout.write(JSON.stringify(s.public)); }
else if(args[0]==='pack') { const d=args[args.indexOf('--pack-destination')+1], filename='wix-pathgrade-1.0.1.tgz'; fs.writeFileSync(path.join(d,filename),Buffer.from(s.downloadedBytes,s.downloadedBytesEncoding)); process.stdout.write(JSON.stringify([{filename}])); }
else { process.stderr.write('unexpected fake npm call'); process.exit(64); }
`;
}

function assertOnlySupportedNpmReads(calls) {
    assert.doesNotMatch(calls, /^stage (?:list|view|download|publish) /m);
}
