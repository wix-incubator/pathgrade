import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repoRoot, '.github/workflows/publish.yml');

test('publishes only through one protected trusted-publishing stage operation', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /node-version:\s*24/);
    assert.match(workflow, /npm[^\n]*(?:>=|11\.15\.0)[^\n]*11\.15\.0/i);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /environment:\s*npm-publish/);
    assert.equal((workflow.match(/npm stage publish/g) ?? []).length, 1);
    assert.match(workflow, /submit_to_stage/);
    assert.match(workflow, /steps\.artifact-state\.outputs\.state == 'absent'[\s\S]*inputs\.submit_to_stage == true/);
    assert.doesNotMatch(workflow, /(?:^|\s)(?:npm|yarn npm) publish(?:\s|$)/m);
    assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|registry[_-]?token/i);
    assert.match(workflow, /package-manager-cache:\s*false/);
});

test('staging has hard dependencies on every retained-artifact release gate', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const stageJob = workflow.slice(workflow.indexOf('\n  stage:'));

    for (const gate of [
        'live-linux',
        'live-macos-codex',
        'platform-artifact-smoke',
        'verify-platform-evidence.mjs',
        'verify-artifact-state.mjs',
        'standalone-package-smoke/run-smoke.mjs',
        'PATHGRADE_STANDALONE_LIVE_PROVIDER=all',
        'PATHGRADE_STANDALONE_LIVE_PROVIDER=codex',
    ]) {
        assert.match(workflow, new RegExp(escapeRegExp(gate)), `missing hard gate ${gate}`);
    }
    assert.match(stageJob, /needs:[\s\S]*live-linux[\s\S]*live-macos-codex[\s\S]*platform-artifact-smoke/);
    assert.doesNotMatch(workflow, /continue-on-error:\s*true|if:\s*always\(\)/);
});

test('OIDC job never performs unsupported stage reads and stops after a stage submission', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const afterStage = workflow.slice(workflow.indexOf('npm stage publish'));

    assert.doesNotMatch(workflow, /npm stage (?:list|view|download)/);
    assert.match(afterStage, /external staged verification|short-lived.*session|exit 1/is);
    assert.match(workflow, /staged_verification_run_id/);
    assert.match(workflow, /pathgrade-staged-verification\/v1|staged-evidence\.json/);
    assert.match(workflow, /gh run download[^\n]*staged-verification/);
    assert.match(workflow, /npm view\s+['"]?@wix\/pathgrade['"]?/);
});

test('approval gate validates auditable live records and provenance against the exact release', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const stageJob = workflow.slice(workflow.indexOf('\n  stage:'));

    assert.match(stageJob, /verify-platform-evidence\.mjs[^\n]*--commit[^\n]*GITHUB_SHA[^\n]*--tarball-sha512[^\n]*--live-evidence-dir/);
    assert.match(stageJob, /args=\([^\n]*--source-commit[^\n]*GITHUB_SHA/);
    assert.match(stageJob, /verify-artifact-state\.mjs/);
    assert.match(stageJob, /--attestation-evidence|--staged-evidence/);
    assert.match(workflow, /pathgrade-live-evidence\/v1/);
    assert.match(workflow, /runtime_environment/);
});

test('quality scripts actually inspect untracked release JavaScript', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-release-quality-'));
    try {
        spawnSync('git', ['init', '-q'], { cwd: fixture });
        fs.mkdirSync(path.join(fixture, 'scripts/release'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'scripts/check-max-lines.sh'), path.join(fixture, 'check-max-lines.sh'));
        fs.copyFileSync(path.join(repoRoot, 'scripts/check-quality-boundaries.sh'), path.join(fixture, 'check-quality-boundaries.sh'));
        fs.writeFileSync(path.join(fixture, 'scripts/release/too-long.mjs'), 'const value = 1;\n'.repeat(4));
        fs.writeFileSync(path.join(fixture, 'scripts/release/broken.mjs'), 'export const = ;\n');

        const maxLines = spawnSync('bash', ['check-max-lines.sh', '.'], {
            cwd: fixture,
            encoding: 'utf8',
            env: { ...process.env, MAX_FILE_LINES: '3' },
        });
        assert.notEqual(maxLines.status, 0);
        assert.match(maxLines.stdout, /scripts\/release\/too-long\.mjs/);

        const boundaries = spawnSync('bash', ['check-quality-boundaries.sh', '.'], { cwd: fixture, encoding: 'utf8' });
        assert.notEqual(boundaries.status, 0);
        assert.match(`${boundaries.stdout}\n${boundaries.stderr}`, /scripts\/release\/broken\.mjs/);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
