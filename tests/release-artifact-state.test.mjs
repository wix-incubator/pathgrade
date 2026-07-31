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

test('classifies a version absent from both public and staged registries', () => {
    const result = runScenario({ public: null, staged: [] });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { state: 'absent', source: null, should_stage: true });
    assertNoStagePublish(result.calls);
});

test('accepts a byte-identical public artifact with matching metadata and provenance', () => {
    const result = runScenario({ public: matchingMetadata() });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { state: 'matching', source: 'public', should_stage: false });
    assert.match(result.calls, /^view /m);
    assert.match(result.calls, /^pack /m);
    assertNoStagePublish(result.calls);
});

test('accepts a byte-identical staged artifact and reports its stage ID', () => {
    const result = runScenario({ public: null, staged: [{ id: 'stage-123', ...matchingMetadata() }] });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        state: 'matching',
        source: 'staged',
        stage_id: 'stage-123',
        should_stage: false,
    });
    assert.match(result.calls, /^stage download stage-123 /m);
    assertNoStagePublish(result.calls);
});

test('fails permanently when existing public contents conflict', () => {
    const result = runScenario({ public: matchingMetadata(), downloadedBytes: 'different artifact' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflict.*contents/i);
    assertNoStagePublish(result.calls);
});

test('fails permanently when source commit differs', () => {
    const result = runScenario({ public: { ...matchingMetadata(), gitHead: 'f'.repeat(40) } });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflict.*source commit/i);
    assertNoStagePublish(result.calls);
});

test('fails permanently when provenance is missing', () => {
    const metadata = matchingMetadata();
    delete metadata.dist.attestations;
    const result = runScenario({ public: metadata });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflict.*provenance/i);
    assertNoStagePublish(result.calls);
});

function matchingMetadata() {
    return {
        name: '@wix/pathgrade',
        version: '1.0.1',
        gitHead: sourceCommit,
        dist: {
            integrity: '',
            attestations: {
                url: 'https://registry.npmjs.org/-/npm/v1/attestations/@wix%2fpathgrade@1.0.1',
                provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
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
        const expectedSha512 = createHash('sha512').update(bytes).digest('hex');
        const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
        const normalized = JSON.parse(JSON.stringify(scenario));
        if (normalized.public?.dist) normalized.public.dist.integrity ||= integrity;
        for (const stage of normalized.staged ?? []) stage.dist.integrity ||= integrity;
        normalized.downloadedBytes ??= bytes.toString('base64');
        normalized.downloadedBytesEncoding = scenario.downloadedBytes === undefined ? 'base64' : 'utf8';
        const scenarioFile = path.join(directory, 'scenario.json');
        fs.writeFileSync(scenarioFile, JSON.stringify(normalized));
        const calls = path.join(directory, 'calls.log');
        const fakeNpm = path.join(directory, 'fake-npm.mjs');
        fs.writeFileSync(fakeNpm, fakeNpmSource());
        fs.chmodSync(fakeNpm, 0o755);

        const result = spawnSync(process.execPath, [
            validator,
            '--package', '@wix/pathgrade',
            '--version', '1.0.1',
            '--tarball', expected,
            '--expected-sha512', expectedSha512,
            '--source-commit', sourceCommit,
            '--npm-command', fakeNpm,
        ], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: { ...process.env, FAKE_NPM_SCENARIO: scenarioFile, FAKE_NPM_CALLS: calls },
        });
        return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function fakeNpmSource() {
    return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_NPM_SCENARIO, 'utf8'));
fs.appendFileSync(process.env.FAKE_NPM_CALLS, args.join(' ') + '\\n');
if (args[0] === 'view') {
  if (!scenario.public) { process.stderr.write('E404 Not Found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(scenario.public));
} else if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const filename = 'wix-pathgrade-1.0.1.tgz';
  fs.writeFileSync(path.join(destination, filename), Buffer.from(scenario.downloadedBytes, scenario.downloadedBytesEncoding));
  process.stdout.write(JSON.stringify([{ filename }]));
} else if (args[0] === 'stage' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(scenario.staged ?? []));
} else if (args[0] === 'stage' && args[1] === 'view') {
  const stage = (scenario.staged ?? []).find(value => value.id === args[2]);
  if (!stage) process.exit(65);
  process.stdout.write(JSON.stringify(stage));
} else if (args[0] === 'stage' && args[1] === 'download') {
  const destination = process.cwd();
  const filename = 'wix-pathgrade-1.0.1-stage.tgz';
  fs.writeFileSync(path.join(destination, filename), Buffer.from(scenario.downloadedBytes, scenario.downloadedBytesEncoding));
  process.stdout.write(JSON.stringify([{ filename }]));
} else {
  process.stderr.write('unexpected fake npm call: ' + args.join(' ') + '\\n');
  process.exit(64);
}
`;
}

function assertNoStagePublish(calls) {
    assert.doesNotMatch(calls, /^stage publish /m);
}
