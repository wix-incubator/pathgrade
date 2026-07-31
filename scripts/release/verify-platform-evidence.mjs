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

export function verifyEvidence({ commit, tarballSha512, evidenceDir, liveEvidenceDir }) {
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
    if (liveEvidenceDir) verifyLiveEvidence(liveEvidenceDir, { commit, tarballSha512 });
    return {
        status: 'pass', tuple_ids: [...expectedTuples.keys()],
        ...(liveEvidenceDir ? { live_provider_ids: ['linux-claude', 'linux-codex', 'macos-codex'] } : {}),
    };
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
    const wsl = tupleId === 'wsl-x64-node24';
    equalField(tupleId, 'runtime_environment.kind', record.runtime_environment?.kind, wsl ? 'wsl' : 'github-hosted');
    equalField(tupleId, 'runtime_environment.observed_platform', record.runtime_environment?.observed_platform, expected.platform);
    equalField(tupleId, 'runtime_environment.observed_arch', record.runtime_environment?.observed_arch, expected.arch);
    equalField(tupleId, 'runtime_environment.wsl', record.runtime_environment?.wsl, wsl);
    if (wsl) {
        if (!/microsoft|wsl/i.test(record.runtime_environment?.kernel_release ?? '')) {
            throw new Error(`${tupleId} runtime_environment.kernel_release must identify WSL`);
        }
        if (typeof record.runtime_environment?.wsl_interop !== 'string' || !record.runtime_environment.wsl_interop) {
            throw new Error(`${tupleId} runtime_environment.wsl_interop must be observed`);
        }
    }
}

function verifyLiveEvidence(directory, release) {
    if (!path.isAbsolute(directory) || !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error('live-evidence-dir must be an existing absolute directory');
    }
    const records = jsonFiles(directory).map(filename => JSON.parse(fs.readFileSync(filename, 'utf8')));
    if (records.length !== 2) throw new Error(`live evidence must contain exactly 2 records, got ${records.length}`);
    const byPlatform = new Map(records.map(record => [record.runtime_environment?.platform, record]));
    if (byPlatform.size !== 2 || !byPlatform.has('linux') || !byPlatform.has('darwin')) {
        throw new Error('live evidence must contain one Linux and one macOS record');
    }
    verifyLiveRecord(byPlatform.get('linux'), 'linux', ['claude', 'codex'], release);
    verifyLiveRecord(byPlatform.get('darwin'), 'darwin', ['codex'], release);
}

function verifyLiveRecord(record, platform, selected, release) {
    const label = platform === 'darwin' ? 'macos' : 'linux';
    equalLive(label, 'schema', record.schema, 'pathgrade-live-evidence/v1');
    equalLive(label, 'status', record.status, 'pass');
    equalLive(label, 'source_commit', record.source_commit, release.commit);
    equalLive(label, 'tarball_sha512', record.tarball_sha512, release.tarballSha512);
    equalLive(label, 'runtime_environment.platform', record.runtime_environment?.platform, platform);
    equalLive(label, 'runtime_environment.node_major', record.runtime_environment?.node_major, 24);
    if (JSON.stringify(record.selected) !== JSON.stringify(selected)) throw new Error(`${label} selected providers differ`);
    equalLive(label, 'passed', record.passed, selected.length);
    equalLive(label, 'skipped', record.skipped, 2 - selected.length);
    if (!Array.isArray(record.providers) || record.providers.length !== 2) {
        throw new Error(`${label} providers must contain exactly 2 records`);
    }
    for (const provider of ['claude', 'codex']) {
        const item = record.providers.find(value => value?.provider === provider);
        if (!item) throw new Error(`${label}-${provider} record is missing`);
        const active = selected.includes(provider);
        equalLive(`${label}-${provider}`, 'id', item.id, `${label}-${provider}`);
        equalLive(`${label}-${provider}`, 'status', item.status, active ? 'pass' : 'skipped');
        equalLive(`${label}-${provider}`, 'skipped', item.skipped, active ? 0 : 1);
        if (active) verifyLiveReport(`${label}-${provider}`, item.report, provider);
        else if ('report' in item) throw new Error(`${label}-${provider} skipped record must not contain a report`);
    }
}

function verifyLiveReport(label, report, provider) {
    equalLive(label, 'report.version', report?.version, 1);
    equalLive(label, 'report.status', report?.status, 'pass');
    equalLive(label, 'report.overall_pass_rate', report?.overall_pass_rate, 1);
    equalLive(label, 'report.provenance.mode', report?.provenance?.mode, 'standalone');
    equalLive(label, 'report.provenance.runtimes.claude.sdk_version', report?.provenance?.runtimes?.claude?.sdk_version, '0.2.116');
    equalLive(label, 'report.provenance.runtimes.claude.claude_code_version', report?.provenance?.runtimes?.claude?.claude_code_version, '2.1.116');
    equalLive(label, 'report.provenance.runtimes.codex.package_version', report?.provenance?.runtimes?.codex?.package_version, '0.144.0');
    equalLive(label, 'report.provenance.runtimes.codex.native_version', report?.provenance?.runtimes?.codex?.native_version, '0.144.0');
    if (!Array.isArray(report?.groups) || report.groups.length !== 1
        || !Array.isArray(report.groups[0]?.trials) || report.groups[0].trials.length !== 1) {
        throw new Error(`${label} report must contain exactly one group and trial`);
    }
    const trial = report.groups[0].trials[0];
    equalLive(label, 'reward', trial.reward, 1);
    const provenance = trial.agent_provenance;
    equalLive(label, 'agent', provenance?.agent, provider);
    equalLive(label, 'transport', provenance?.transport, provider === 'claude' ? 'native' : 'app-server');
    equalLive(label, 'authentication', provenance?.authentication, 'api-key');
    equalLive(label, 'model.id', provenance?.model?.id, provider === 'claude' ? null : 'gpt-5.4');
    equalLive(label, 'model.source', provenance?.model?.source, provider === 'claude' ? 'provider-default' : 'pathgrade-default');
    equalLive(label, 'runtime.package', provenance?.runtime?.package, provider === 'claude' ? '@anthropic-ai/claude-agent-sdk' : '@openai/codex');
    equalLive(label, 'runtime.package_version', provenance?.runtime?.package_version, provider === 'claude' ? '0.2.116' : '0.144.0');
    equalLive(label, 'runtime.embedded_binary_version', provenance?.runtime?.embedded_binary_version, provider === 'claude' ? '2.1.116' : '0.144.0');
    equalLive(label, 'runtime.provenance', provenance?.runtime?.provenance, 'bundled');
}

function equalLive(label, field, actual, expected) {
    if (actual !== expected) throw new Error(`${label} ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function equalField(tupleId, field, actual, expected) {
    if (actual !== expected) {
        throw new Error(`${tupleId} ${field} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function parseArgs(args) {
    const allowed = new Set(['--commit', '--tarball-sha512', '--evidence-dir', '--live-evidence-dir']);
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
        liveEvidenceDir: options.live_evidence_dir,
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
