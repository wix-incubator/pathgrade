#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedTuples = new Map([
    ['darwin-arm64-node24', { platform: 'darwin', arch: 'arm64' }],
    ['darwin-x64-node24', { platform: 'darwin', arch: 'x64' }],
    ['linux-arm64-node24', { platform: 'linux', arch: 'arm64' }],
    ['linux-x64-node24', { platform: 'linux', arch: 'x64' }],
    ['wsl-x64-node24', { platform: 'linux', arch: 'x64' }],
]);
const expectedRuntimes = {
    claude: { sdk_version: '0.2.116', claude_code_version: '2.1.116' },
    codex: { package_version: '0.144.0', native_version: '0.144.0' },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = verifyEvidence(options);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`platform evidence rejected: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

export function verifyEvidence({ commit, tarballSha512, evidenceDir }) {
    requireValue('commit', commit);
    requireSha512(tarballSha512);
    if (!evidenceDir || !path.isAbsolute(evidenceDir)) throw new Error('evidence-dir must be an absolute path');
    if (!fs.statSync(evidenceDir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`evidence-dir does not exist: ${evidenceDir}`);
    }

    const records = new Map();
    for (const filename of jsonFiles(evidenceDir)) {
        let record;
        try {
            record = JSON.parse(fs.readFileSync(filename, 'utf8'));
        } catch {
            throw new Error(`${path.basename(filename)} contains malformed JSON`);
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error(`${path.basename(filename)} must contain one evidence object`);
        }
        const tupleId = record.tuple_id;
        if (typeof tupleId !== 'string' || !expectedTuples.has(tupleId)) {
            throw new Error(`unknown tuple_id ${String(tupleId)}`);
        }
        if (records.has(tupleId)) throw new Error(`duplicate ${tupleId}`);
        records.set(tupleId, record);
    }

    for (const tupleId of expectedTuples.keys()) {
        if (!records.has(tupleId)) throw new Error(`missing ${tupleId}`);
    }
    for (const [tupleId, expected] of expectedTuples) {
        verifyRecord(tupleId, records.get(tupleId), expected, { commit, tarballSha512 });
    }
    return { status: 'pass', tuple_ids: [...expectedTuples.keys()] };
}

function verifyRecord(tupleId, record, expected, release) {
    equalField(tupleId, 'status', record.status, 'pass');
    equalField(tupleId, 'platform', record.platform, expected.platform);
    equalField(tupleId, 'arch', record.arch, expected.arch);
    equalField(tupleId, 'node_major', record.node_major, 24);
    equalField(tupleId, 'package.name', record.package?.name, '@wix/pathgrade');
    equalField(tupleId, 'package.version', record.package?.version, packageVersion());
    equalField(tupleId, 'source_commit', record.source_commit, release.commit);
    equalField(tupleId, 'tarball_sha512', record.tarball_sha512, release.tarballSha512);
    equalField(tupleId, 'runtimes.claude.sdk_version', record.runtimes?.claude?.sdk_version, expectedRuntimes.claude.sdk_version);
    equalField(tupleId, 'runtimes.claude.claude_code_version', record.runtimes?.claude?.claude_code_version, expectedRuntimes.claude.claude_code_version);
    equalField(tupleId, 'runtimes.codex.package_version', record.runtimes?.codex?.package_version, expectedRuntimes.codex.package_version);
    equalField(tupleId, 'runtimes.codex.native_version', record.runtimes?.codex?.native_version, expectedRuntimes.codex.native_version);
}

function equalField(tupleId, field, actual, expected) {
    if (actual !== expected) {
        throw new Error(`${tupleId} ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function parseArgs(args) {
    const allowed = new Set(['--commit', '--tarball-sha512', '--evidence-dir']);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!allowed.has(option)) throw new Error(`unknown argument: ${option}`);
        if (!value) throw new Error(`missing value for ${option}`);
        options[option.slice(2).replaceAll('-', '_')] = value;
    }
    return {
        commit: options.commit,
        tarballSha512: options.tarball_sha512,
        evidenceDir: options.evidence_dir,
    };
}

function jsonFiles(directory) {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => path.join(entry.parentPath, entry.name))
        .sort();
}

function requireValue(field, value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
}

function requireSha512(value) {
    if (typeof value !== 'string' || !/^[a-f\d]{128}$/i.test(value)) {
        throw new Error('tarball-sha512 must be a 128-character hexadecimal SHA-512');
    }
}

function packageVersion() {
    const packageJson = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
}
