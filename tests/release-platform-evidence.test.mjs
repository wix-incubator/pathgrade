import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validator = path.join(repoRoot, 'scripts/release/verify-platform-evidence.mjs');
const commit = '0123456789abcdef0123456789abcdef01234567';
const tarballSha512 = 'a'.repeat(128);
const tuples = {
    'darwin-arm64-node24': ['darwin', 'arm64'],
    'darwin-x64-node24': ['darwin', 'x64'],
    'linux-arm64-node24': ['linux', 'arm64'],
    'linux-x64-node24': ['linux', 'x64'],
    'wsl-x64-node24': ['linux', 'x64'],
};

test('accepts exactly one current passing record for every supported tuple', () => {
    const result = runValidator(Object.entries(tuples).map(([tupleId, [platform, arch]]) => (
        evidence(tupleId, platform, arch)
    )));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        status: 'pass',
        tuple_ids: Object.keys(tuples),
    });
});

for (const missingTuple of Object.keys(tuples)) {
    test(`rejects a missing ${missingTuple} record`, () => {
        const records = Object.entries(tuples)
            .filter(([tupleId]) => tupleId !== missingTuple)
            .map(([tupleId, [platform, arch]]) => evidence(tupleId, platform, arch));

        assertRejected(runValidator(records), missingTuple);
    });
}

test('rejects duplicate and unknown tuple records', () => {
    const records = validRecords();
    assertRejected(runValidator([...records, records[0]]), 'duplicate darwin-arm64-node24');
    assertRejected(runValidator([...records, evidence('solaris-x64-node24', 'sunos', 'x64')]), 'unknown tuple_id solaris-x64-node24');
});

test('rejects stale commits and wrong tarball hashes by field', () => {
    const stale = validRecords();
    stale[0] = { ...stale[0], source_commit: 'f'.repeat(40) };
    assertRejected(runValidator(stale), 'darwin-arm64-node24 source_commit');

    const wrongHash = validRecords();
    wrongHash[1] = { ...wrongHash[1], tarball_sha512: 'b'.repeat(128) };
    assertRejected(runValidator(wrongHash), 'darwin-x64-node24 tarball_sha512');
});

test('rejects wrong runtime versions and non-passing records by field', () => {
    const wrongRuntime = validRecords();
    wrongRuntime[2] = {
        ...wrongRuntime[2],
        runtimes: {
            ...wrongRuntime[2].runtimes,
            codex: { package_version: '0.145.0', native_version: '0.144.0' },
        },
    };
    assertRejected(runValidator(wrongRuntime), 'linux-arm64-node24 runtimes.codex.package_version');

    const failed = validRecords();
    failed[3] = { ...failed[3], status: 'fail' };
    assertRejected(runValidator(failed), 'linux-x64-node24 status');
});

test('rejects malformed JSON with the evidence filename', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-platform-evidence-'));
    try {
        fs.writeFileSync(path.join(directory, 'broken.json'), '{not json');
        assertRejected(run(directory), 'broken.json');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function validRecords() {
    return Object.entries(tuples).map(([tupleId, [platform, arch]]) => evidence(tupleId, platform, arch));
}

function evidence(tupleId, platform, arch) {
    return {
        tuple_id: tupleId,
        platform,
        arch,
        node_major: 24,
        package: { name: '@wix/pathgrade', version: '1.0.1' },
        runtimes: {
            claude: { sdk_version: '0.2.116', claude_code_version: '2.1.116' },
            codex: { package_version: '0.144.0', native_version: '0.144.0' },
        },
        tarball_sha512: tarballSha512,
        source_commit: commit,
        status: 'pass',
    };
}

function runValidator(records) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-platform-evidence-'));
    try {
        records.forEach((record, index) => {
            fs.writeFileSync(path.join(directory, `${index}-${record.tuple_id}.json`), JSON.stringify(record));
        });
        return run(directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function run(evidenceDir) {
    return spawnSync(process.execPath, [
        validator,
        '--commit', commit,
        '--tarball-sha512', tarballSha512,
        '--evidence-dir', evidenceDir,
    ], { cwd: repoRoot, encoding: 'utf8' });
}

function assertRejected(result, diagnostic) {
    assert.notEqual(result.status, 0, `expected rejection, got stdout: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(escapeRegExp(diagnostic)));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
