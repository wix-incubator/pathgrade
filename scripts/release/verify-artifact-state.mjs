#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = 'https://registry.npmjs.org';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = verifyArtifactState(options);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

export function verifyArtifactState(options) {
    validateOptions(options);
    const actualExpectedSha512 = sha512File(options.tarball);
    if (actualExpectedSha512 !== options.expectedSha512) {
        throw new Error('retained tarball does not match expected SHA-512');
    }
    const expectedIntegrity = `sha512-${Buffer.from(options.expectedSha512, 'hex').toString('base64')}`;
    const spec = `${options.packageName}@${options.version}`;
    const publicView = npmResult(options.npmCommand, ['view', spec, '--json', '--registry', registry]);
    if (publicView.status === 0) {
        const metadata = parseJsonOutput(publicView.stdout, 'public package metadata');
        verifyMetadata(metadata, options, expectedIntegrity, 'public');
        const downloaded = downloadPublic(options.npmCommand, spec);
        verifyContents(downloaded, options.expectedSha512, 'public');
        return { state: 'matching', source: 'public', should_stage: false };
    }
    if (!/E404|404 Not Found|is not in this registry/i.test(publicView.stderr)) {
        throw new Error(`npm view failed without an absence response: ${publicView.stderr.trim()}`);
    }

    const stageList = npm(options.npmCommand, ['stage', 'list', spec, '--json', '--registry', registry]);
    const stages = normalizeStages(parseJsonOutput(stageList.stdout, 'staged package metadata'))
        .filter(stage => stage.name === options.packageName && stage.version === options.version);
    if (stages.length > 1) throw new Error(`conflict: multiple staged artifacts exist for ${spec}`);
    if (stages.length === 0) return { state: 'absent', source: null, should_stage: true };

    const stageSummary = stages[0];
    const stageView = npm(options.npmCommand, [
        'stage', 'view', stageSummary.id, '--json', '--registry', registry,
    ]);
    const stage = { ...stageSummary, ...parseJsonOutput(stageView.stdout, 'staged package details') };
    verifyMetadata(stage, options, expectedIntegrity, 'staged');
    const downloaded = downloadStage(options.npmCommand, stage.id);
    verifyContents(downloaded, options.expectedSha512, 'staged');
    return {
        state: 'matching',
        source: 'staged',
        stage_id: stage.id,
        should_stage: false,
    };
}

function verifyMetadata(metadata, options, expectedIntegrity, source) {
    if (metadata.name !== options.packageName || metadata.version !== options.version) {
        conflict(`${source} package identity`);
    }
    if (metadata.dist?.integrity !== expectedIntegrity) conflict(`${source} integrity`);
    if (metadata.gitHead !== options.sourceCommit) conflict(`${source} source commit`);
    const attestations = metadata.dist?.attestations ?? metadata.attestations;
    if (!attestations?.url || !attestations?.provenance?.predicateType) {
        conflict(`${source} provenance or attestation`);
    }
}

function verifyContents(filename, expectedSha512, source) {
    if (sha512File(filename) !== expectedSha512) conflict(`${source} contents`);
}

function downloadPublic(npmCommand, spec) {
    return withTempDirectory(directory => {
        const result = npm(npmCommand, [
            'pack', spec, '--json', '--pack-destination', directory, '--registry', registry,
        ]);
        return downloadedFilename(directory, result.stdout, 'public package download');
    });
}

function downloadStage(npmCommand, stageId) {
    return withTempDirectory(directory => {
        const result = npm(npmCommand, [
            'stage', 'download', stageId, '--json', '--registry', registry,
        ], { cwd: directory });
        return downloadedFilename(directory, result.stdout, 'staged package download');
    });
}

function withTempDirectory(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-artifact-state-'));
    try {
        const filename = callback(directory);
        const copy = path.join(os.tmpdir(), `pathgrade-artifact-${process.pid}-${Date.now()}.tgz`);
        fs.copyFileSync(filename, copy);
        return copy;
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function downloadedFilename(directory, stdout, label) {
    const parsed = parseJsonOutput(stdout, label);
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
    if (typeof filename !== 'string') throw new Error(`${label} did not name a tarball`);
    const resolved = path.resolve(directory, filename);
    if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error(`${label} tarball is unavailable`);
    }
    return resolved;
}

function normalizeStages(value) {
    const stages = Array.isArray(value)
        ? value
        : Array.isArray(value?.stages)
            ? value.stages
            : value && typeof value === 'object'
                ? Object.values(value)
                : undefined;
    if (!Array.isArray(stages)) throw new Error('staged package metadata must be an array');
    return stages.map(stage => {
        const packageSpec = typeof stage.package === 'string' ? stage.package : undefined;
        const parsedSpec = packageSpec?.match(/^(@[^/]+\/[^@]+|[^@]+)@(.+)$/);
        return {
            ...stage,
            name: stage.name ?? stage.package?.name ?? parsedSpec?.[1],
            version: stage.version ?? stage.package?.version ?? parsedSpec?.[2],
        };
    });
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
    if (result.error) throw new Error(`npm command could not start: ${result.error.message}`);
    return result;
}

function redact(value, env) {
    let redacted = value.replace(/(?:npm_[A-Za-z_]*token|NODE_AUTH_TOKEN|NPM_TOKEN)=\S+/gi, '[credential redacted]');
    for (const [key, secret] of Object.entries(env)) {
        if (/token|credential|oidc/i.test(key) && typeof secret === 'string' && secret.length >= 6) {
            redacted = redacted.replaceAll(secret, '[credential redacted]');
        }
    }
    return redacted;
}

function parseJsonOutput(value, label) {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`${label} returned malformed JSON`);
    }
}

function parseArgs(args) {
    const allowed = new Set([
        '--package', '--version', '--tarball', '--expected-sha512', '--source-commit', '--npm-command',
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
        packageName: parsed['--package'] ?? '@wix/pathgrade',
        version: parsed['--version'],
        tarball: parsed['--tarball'],
        expectedSha512: parsed['--expected-sha512'],
        sourceCommit: parsed['--source-commit'],
        npmCommand: parsed['--npm-command'] ?? 'npm',
    };
}

function validateOptions(options) {
    for (const [name, value] of Object.entries(options)) {
        if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
    }
    if (!path.isAbsolute(options.tarball) || !fs.existsSync(options.tarball)) {
        throw new Error('tarball must be an existing absolute path');
    }
    if (!/^[a-f\d]{128}$/i.test(options.expectedSha512)) throw new Error('expected-sha512 is invalid');
}

function sha512File(filename) {
    const digest = createHash('sha512').update(fs.readFileSync(filename)).digest('hex');
    if (filename.startsWith(os.tmpdir()) && path.basename(filename).startsWith('pathgrade-artifact-')) {
        fs.rmSync(filename, { force: true });
    }
    return digest;
}

function conflict(field) {
    throw new Error(`conflict: ${field} differs; npm versions cannot be overwritten`);
}
