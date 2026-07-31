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

test('post-stage verification downloads the staged artifact without rebuilding it', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    const afterStage = workflow.slice(workflow.indexOf('npm stage publish'));

    assert.match(afterStage, /npm stage download/);
    assert.match(afterStage, /run-smoke\.mjs[^\n]*--tarball[^\n]*DOWNLOADED_STAGED_TARBALL[^\n]*--expected-sha512[^\n]*RETAINED_SCOPED_SHA512/);
    assert.doesNotMatch(afterStage, /npm pack|yarn build/);
    assert.match(workflow, /npm view\s+['"]?@wix\/pathgrade['"]?/);
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
