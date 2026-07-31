import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(repoRoot, 'tests/fixtures/standalone-package');
const options = parseArgs(process.argv.slice(2));
const temporaryDirectories = [];

try {
    const artifact = resolveArtifact(options);
    const shims = makeTempDir('pathgrade-standalone-shims-');
    createFailingShims(shims);
    const firstPrefix = installTarball(artifact.tarball, shims);

    for (const manifest of [false, true]) {
        runSuccessfulCases({ artifact, prefix: firstPrefix, shims, manifest, command: 'npx' });
        runSuccessfulCases({ artifact, prefix: firstPrefix, shims, manifest, command: 'global' });
    }
    runMissingDependency({ artifact, prefix: firstPrefix, shims });
    runPackagingDefect({ artifact, shims });
    assert.equal(readShimCalls(shims), '', 'standalone must not invoke PATH shims');
    process.stdout.write(`${JSON.stringify({ tarball: artifact.tarball, sha512: artifact.sha512 })}\n`);
} finally {
    for (const directory of temporaryDirectories.reverse()) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function parseArgs(args) {
    const result = {};
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option !== '--tarball' && option !== '--expected-sha512') {
            throw new Error(`unknown argument: ${option}`);
        }
        const value = args[++index];
        if (!value) throw new Error(`missing value for ${option}`);
        result[option.slice(2).replace('-', '')] = value;
    }
    if (result.tarball && !path.isAbsolute(result.tarball)) {
        throw new Error('--tarball must be an absolute path');
    }
    return result;
}

function resolveArtifact(options) {
    if (options.tarball) {
        assert.ok(fs.existsSync(options.tarball), `tarball does not exist: ${options.tarball}`);
        assert.ok(options.tarball.endsWith('.tgz'), '--tarball must name a .tgz file');
        const sha512 = sha512File(options.tarball);
        if (options.expectedsha512) assert.equal(sha512, options.expectedsha512, 'tarball SHA-512');
        assertPackedSurface(options.tarball);
        return { tarball: options.tarball, sha512 };
    }
    run('yarn', ['build'], repoRoot);
    const artifacts = makeTempDir('pathgrade-standalone-artifact-');
    const packed = run('npm', ['pack', '--json', '--pack-destination', artifacts], repoRoot);
    const parsed = JSON.parse(packed.stdout);
    assert.equal(parsed.length, 1, 'npm pack should create exactly one artifact');
    const tarball = path.join(artifacts, parsed[0].filename);
    assertPackedSurface(tarball);
    return { tarball, sha512: sha512File(tarball) };
}

function runSuccessfulCases({ artifact, prefix, shims, manifest, command }) {
    const target = createTarget(manifest);
    const state = path.join(makeTempDir('pathgrade-standalone-state-'), 'lifecycle.txt');
    const changed = path.join(target, 'changed-files.txt');
    fs.writeFileSync(changed, 'basic.eval.ts\n');
    const baseEnv = smokeEnv({
        shims,
        state,
        ...(command === 'global' ? { prefix } : {}),
    });
    const invoke = (args) => command === 'npx'
        ? run('npx', ['--yes', '--package', artifact.tarball, 'pathgrade', ...args], target, baseEnv)
        : run(path.join(prefix, 'bin', 'pathgrade'), args, target, baseEnv);

    invoke(['standalone', 'run', 'basic.eval.ts']);
    assertSuccessfulTarget(target, state, artifact, manifest);
    resetRunState(target, state);
    invoke(['standalone']);
    assertSuccessfulTarget(target, state, artifact, manifest);
    resetRunState(target, state);
    invoke(['standalone', 'run', '--changed', '--changed-files=changed-files.txt']);
    assertSuccessfulTarget(target, state, artifact, manifest);
    resetRunState(target, state);
    const affected = invoke(['standalone', 'affected', '--changed-files=changed-files.txt']);
    assert.match(affected.stdout, /basic\.eval\.ts/);
    assertTargetShape(target, manifest);
}

function runMissingDependency({ artifact, prefix, shims }) {
    const target = createTarget(false, { missing: true });
    const result = runResult(path.join(prefix, 'bin', 'pathgrade'), ['standalone', 'run', 'missing-dependency.eval.ts'], target, smokeEnv({ shims, prefix }));
    assert.notEqual(result.status, 0, 'missing project dependency should fail');
    assert.match(`${result.stdout}\n${result.stderr}`, /project dependency "package-that-pathgrade-must-not-supply" is unavailable/);
    assert.match(`${result.stdout}\n${result.stderr}`, /missing-dependency\.eval\.ts/);
}

function runPackagingDefect({ artifact, shims }) {
    const prefix = installTarball(artifact.tarball, shims);
    const installedVitest = path.join(prefix, 'lib/node_modules/@wix/pathgrade/node_modules/vitest');
    assert.ok(fs.existsSync(installedVitest), 'temporary install must contain bundled Vitest');
    fs.rmSync(installedVitest, { recursive: true, force: true });
    const target = createTarget(false);
    const result = runResult(path.join(prefix, 'bin', 'pathgrade'), ['standalone', 'run', 'basic.eval.ts'], target, smokeEnv({ shims, prefix }));
    assert.notEqual(result.status, 0, 'installed tool graph defect should fail');
    assert.match(`${result.stdout}\n${result.stderr}`, /bundled Vitest 4\.1\.7 could not be resolved; this is a Pathgrade packaging defect/);
}

function assertSuccessfulTarget(target, state, artifact, manifest) {
    assert.deepEqual(fs.readFileSync(state, 'utf8').trim().split('\n').sort(), ['agent-disposed', 'evaluation-scored', 'evaluation-started']);
    const report = JSON.parse(fs.readFileSync(path.join(target, '.pathgrade/results.json'), 'utf8'));
    assert.equal(report.version, 1);
    assert.equal(report.status, 'pass');
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].trials.length, 1);
    assert.equal(report.groups[0].trials[0].reward, 1);
    assert.equal(report.provenance.mode, 'standalone');
    assert.equal(report.provenance.package_version, packageVersion());
    assert.equal(report.provenance.vitest_version, '4.1.7');
    assert.deepEqual(report.provenance.runtimes, {
        claude: { sdk_version: '0.2.116', claude_code_version: '2.1.116' },
        codex: { package_version: '0.144.0', native_version: '0.144.0' },
    });
    assertTargetShape(target, manifest);
    assert.ok(artifact.sha512.length === 128);
}

function assertTargetShape(target, manifest) {
    assert.equal(fs.existsSync(path.join(target, 'node_modules')), false, 'target must not gain node_modules');
    for (const name of ['.vite', 'coverage', 'attachments', 'blob-reports', '.vitest']) {
        assert.equal(fs.existsSync(path.join(target, name)), false, `target must not gain ${name}`);
    }
    assert.equal(fs.existsSync(path.join(target, 'package.json')), manifest);
}

function resetRunState(target, state) {
    fs.rmSync(path.join(target, '.pathgrade'), { recursive: true, force: true });
    fs.rmSync(state, { force: true });
}

function createTarget(manifest, options = {}) {
    const target = makeTempDir('pathgrade-standalone-target-');
    for (const name of ['basic.eval.ts', 'vitest.config.ts', '.env']) {
        fs.copyFileSync(path.join(fixtureRoot, name), path.join(target, name));
    }
    if (manifest) fs.copyFileSync(path.join(fixtureRoot, 'package.json'), path.join(target, 'package.json'));
    if (options.missing) fs.copyFileSync(path.join(fixtureRoot, 'missing-dependency.eval.ts'), path.join(target, 'missing-dependency.eval.ts'));
    return target;
}

function installTarball(tarball, shims) {
    const prefix = makeTempDir('pathgrade-standalone-prefix-');
    run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], repoRoot, smokeEnv({ shims, prefix }));
    return prefix;
}

function smokeEnv({ shims, state, prefix }) {
    return {
        ...process.env,
        PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`,
        ...(state ? { PATHGRADE_STANDALONE_SMOKE_STATE_FILE: state } : {}),
        ...(prefix ? { npm_config_prefix: prefix } : {}),
    };
}

function createFailingShims(directory) {
    for (const command of ['vitest', 'codex', 'claude']) {
        const filename = path.join(directory, command);
        fs.writeFileSync(filename, `#!/bin/sh\necho ${command} >> "${path.join(directory, 'calls')}"\nexit 97\n`);
        fs.chmodSync(filename, 0o755);
    }
}

function readShimCalls(directory) {
    const calls = path.join(directory, 'calls');
    return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
}

function packageVersion() {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
}

function assertPackedSurface(tarball) {
    const entries = run('tar', ['-tzf', tarball], repoRoot).stdout.split('\n');
    for (const entry of [
        'package/bin/pathgrade.js',
        'package/dist/pathgrade.js',
        'package/dist/sdk/index.js',
        'package/dist/sdk/index.d.ts',
    ]) {
        assert.ok(entries.includes(entry), `packed artifact is missing ${entry}`);
    }
}

function sha512File(filename) {
    return createHash('sha512').update(fs.readFileSync(filename)).digest('hex');
}

function makeTempDir(prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function run(command, args, cwd, env = process.env) {
    const result = runResult(command, args, cwd, env);
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    return result;
}

function runResult(command, args, cwd, env) {
    return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}
