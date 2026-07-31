#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = 'https://registry.npmjs.org';
const repository = 'wix-incubator/pathgrade';
const workflow = 'publish.yml';
const predicateType = 'https://slsa.dev/provenance/v1';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const result = verifyArtifactState(parseArgs(process.argv.slice(2)));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`${redact(error instanceof Error ? error.message : String(error), process.env)}\n`);
        process.exitCode = 1;
    }
}

export function verifyArtifactState(options) {
    validateOptions(options);
    const retainedSha512 = sha512File(options.tarball);
    if (retainedSha512 !== options.expectedSha512) {
        throw new Error('retained tarball does not match expected SHA-512');
    }
    const expectedIntegrity = toIntegrity(options.expectedSha512);
    const spec = `${options.packageName}@${options.version}`;
    const publicView = npmResult(options.npmCommand, ['view', spec, '--json', '--registry', registry]);
    if (publicView.status === 0) {
        const metadata = parseJsonOutput(publicView.stdout, 'public package metadata');
        verifyMetadata(metadata, options, expectedIntegrity, 'public');
        verifyContents(downloadPublic(options.npmCommand, spec), options.expectedSha512, 'public');
        if (!options.attestationEvidence) throw new Error('conflict: verified provenance evidence is required');
        verifyProvenance(readJsonFile(options.attestationEvidence, 'verified provenance evidence'), options);
        return { state: 'matching', source: 'public', should_stage: false };
    }
    if (!/E404|404 Not Found|is not in this registry/i.test(publicView.stderr)) {
        throw new Error(`npm view failed without an absence response: ${redact(publicView.stderr, process.env).trim()}`);
    }
    if (!options.stagedEvidence) return { state: 'absent', source: null, should_stage: true };
    const staged = readJsonFile(options.stagedEvidence, 'external staged verification evidence');
    verifyStagedEvidence(staged, options, expectedIntegrity);
    return { state: 'matching', source: 'staged', stage_id: staged.stage_id, should_stage: false };
}

function verifyStagedEvidence(evidence, options, expectedIntegrity) {
    if (evidence.schema !== 'pathgrade-staged-verification/v1' || evidence.status !== 'verified') {
        throw new Error('external staged verification evidence is not verified');
    }
    if (typeof evidence.stage_id !== 'string' || !evidence.stage_id) {
        throw new Error('external staged verification evidence has no stage ID');
    }
    verifyMetadata(evidence.package, options, expectedIntegrity, 'staged');
    const evidenceDirectory = path.dirname(options.stagedEvidence);
    const downloadedTarball = path.resolve(evidenceDirectory, evidence.downloaded_tarball ?? '');
    if (!downloadedTarball.startsWith(`${evidenceDirectory}${path.sep}`) || !fs.existsSync(downloadedTarball)) {
        throw new Error('external staged verification evidence tarball is unavailable');
    }
    verifyContents(downloadedTarball, options.expectedSha512, 'staged');
    if (evidence.tarball_sha512 !== options.expectedSha512
        || evidence.standalone_smoke?.status !== 'pass'
        || evidence.standalone_smoke?.tarball_sha512 !== options.expectedSha512
        || evidence.standalone_smoke?.rebuilt !== false) {
        conflict('staged downloaded-tarball smoke evidence');
    }
    verifyProvenance(evidence.provenance, options);
}

function verifyMetadata(metadata, options, expectedIntegrity, source) {
    if (metadata?.name !== options.packageName || metadata?.version !== options.version) {
        conflict(`${source} package identity`);
    }
    if (metadata.dist?.integrity !== expectedIntegrity) conflict(`${source} integrity`);
    if (metadata.gitHead !== options.sourceCommit) conflict(`${source} source commit`);
    const attestations = metadata.dist?.attestations ?? metadata.attestations;
    if (!attestations?.url || attestations?.provenance?.predicateType !== predicateType) {
        conflict(`${source} provenance metadata`);
    }
}

function verifyProvenance(evidence, options) {
    if (evidence?.schema !== 'pathgrade-provenance-verification/v1'
        || evidence?.verification?.status !== 'verified'
        || evidence?.verification?.verifier !== 'npm-registry-sigstore'
        || !/^[a-f\d]{64}$/i.test(evidence?.verification?.bundle_sha256 ?? '')
        || !Number.isSafeInteger(evidence?.verification?.rekor_log_index)
        || evidence.verification.rekor_log_index < 0) {
        throw new Error('conflict: verified provenance evidence is invalid');
    }
    if (evidence.verification.repository !== repository) conflict('provenance repository');
    if (evidence.verification.workflow !== workflow) conflict('provenance workflow');
    if (evidence.verification.source_commit !== options.sourceCommit) conflict('provenance source commit');
    const statement = evidence.statement;
    if (statement?._type !== 'https://in-toto.io/Statement/v1') conflict('provenance statement type');
    if (statement?.predicateType !== predicateType) conflict('provenance predicate');
    const expectedSubject = `pkg:npm/${encodeURIComponent(options.packageName).replace('%2F', '/')}@${options.version}`;
    const subject = statement?.subject?.find(value => value?.name === expectedSubject);
    if (!subject) conflict('provenance subject identity');
    if (subject.digest?.sha512 !== options.expectedSha512) conflict('provenance subject digest');
    const dependencies = statement?.predicate?.buildDefinition?.resolvedDependencies;
    const build = statement?.predicate?.buildDefinition;
    if (build?.buildType !== 'https://actions.github.io/buildtypes/workflow/v1') {
        conflict('provenance build type');
    }
    if (build?.externalParameters?.workflow?.repository !== `https://github.com/${repository}`) {
        conflict('provenance repository');
    }
    if (build?.externalParameters?.workflow?.path !== `.github/workflows/${workflow}`) {
        conflict('provenance workflow');
    }
    const source = Array.isArray(dependencies) && dependencies.find(value => (
        typeof value?.uri === 'string'
        && value.uri.startsWith(`git+https://github.com/${repository}@`)
    ));
    if (!source || source.digest?.gitCommit !== options.sourceCommit) conflict('provenance source commit');
    const builderId = statement?.predicate?.runDetails?.builder?.id;
    if (typeof builderId !== 'string'
        || !builderId.startsWith(`https://github.com/${repository}/.github/workflows/${workflow}@`)) {
        conflict('provenance workflow');
    }
    if (evidence.verification.certificate_identity !== builderId) conflict('provenance certificate identity');
}

function downloadPublic(npmCommand, spec) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-artifact-state-'));
    try {
        const result = npm(npmCommand, ['pack', spec, '--json', '--pack-destination', directory, '--registry', registry]);
        const parsed = parseJsonOutput(result.stdout, 'public package download');
        const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
        if (typeof filename !== 'string') throw new Error('public package download did not name a tarball');
        const resolved = path.resolve(directory, filename);
        if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`) || !fs.existsSync(resolved)) {
            throw new Error('public package download tarball is unavailable');
        }
        return fs.readFileSync(resolved);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function verifyContents(filenameOrBytes, expectedSha512, source) {
    const bytes = Buffer.isBuffer(filenameOrBytes) ? filenameOrBytes : fs.readFileSync(filenameOrBytes);
    if (sha512(bytes) !== expectedSha512) conflict(`${source} contents`);
}

function npm(command, args, options = {}) {
    const result = npmResult(command, args, options);
    if (result.status !== 0) {
        throw new Error(`npm command failed (${args.slice(0, 2).join(' ')}): ${redact(result.stderr, process.env).trim()}`);
    }
    return result;
}

function npmResult(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', env: process.env, ...options });
    if (result.error) throw new Error(`npm command could not start: ${redact(result.error.message, process.env)}`);
    return result;
}

function redact(value, env) {
    let output = String(value);
    for (const [key, secret] of Object.entries(env)) {
        if (/token|credential|oidc|auth|api[_-]?key|secret/i.test(key)
            && typeof secret === 'string' && secret.length >= 6) {
            output = output.replaceAll(secret, '[credential redacted]');
        }
    }
    return output
        .replace(/(?:Authorization\s*:\s*)?Bearer\s+\S+/gi, '[credential redacted]')
        .replace(/(?:npm_[\w-]*token|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|_auth)=\S+/gi, '[credential redacted]');
}

function parseArgs(args) {
    const allowed = new Set([
        '--package', '--version', '--tarball', '--expected-sha512', '--source-commit', '--npm-command',
        '--attestation-evidence', '--staged-evidence',
    ]);
    const parsed = {};
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!allowed.has(option)) throw new Error(`unknown argument: ${option}`);
        if (!value) throw new Error(`missing value for ${option}`);
        parsed[option] = value;
    }
    return {
        packageName: parsed['--package'] ?? '@wix/pathgrade', version: parsed['--version'],
        tarball: parsed['--tarball'], expectedSha512: parsed['--expected-sha512'],
        sourceCommit: parsed['--source-commit'], npmCommand: parsed['--npm-command'] ?? 'npm',
        attestationEvidence: parsed['--attestation-evidence'], stagedEvidence: parsed['--staged-evidence'],
    };
}

function validateOptions(options) {
    for (const name of ['packageName', 'version', 'tarball', 'expectedSha512', 'sourceCommit', 'npmCommand']) {
        if (typeof options[name] !== 'string' || !options[name]) throw new Error(`${name} is required`);
    }
    if (!path.isAbsolute(options.tarball) || !fs.existsSync(options.tarball)) {
        throw new Error('tarball must be an existing absolute path');
    }
    if (!/^[a-f\d]{128}$/i.test(options.expectedSha512)) throw new Error('expected-sha512 is invalid');
    if (!/^[a-f\d]{40}$/i.test(options.sourceCommit)) throw new Error('source-commit is invalid');
}

function readJsonFile(filename, label) {
    if (!path.isAbsolute(filename) || !fs.existsSync(filename)) throw new Error(`${label} file is unavailable`);
    return parseJsonOutput(fs.readFileSync(filename, 'utf8'), label);
}

function parseJsonOutput(value, label) {
    try { return JSON.parse(value); } catch { throw new Error(`${label} contains malformed JSON`); }
}

function sha512File(filename) { return sha512(fs.readFileSync(filename)); }
function sha512(bytes) { return createHash('sha512').update(bytes).digest('hex'); }
function toIntegrity(hex) { return `sha512-${Buffer.from(hex, 'hex').toString('base64')}`; }
function conflict(field) { throw new Error(`conflict: ${field} differs; npm versions cannot be overwritten`); }
