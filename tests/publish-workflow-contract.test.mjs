import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/publish.yml'), 'utf8');
const prepareJob = workflow.slice(workflow.indexOf('\n  prepare:'), workflow.indexOf('\n  stage:'));
const stageJob = workflow.slice(workflow.indexOf('\n  stage:'));

test('release staging is manual, tag-only, and serialized', () => {
    assert.match(workflow, /on:\s*\n\s*workflow_dispatch:\s*\n/);
    assert.doesNotMatch(workflow, /\n\s*push:/);
    assert.doesNotMatch(workflow, /\binputs:/);
    assert.match(workflow, /concurrency:\s*\n\s*group:[^\n]*github\.ref[^\n]*\n\s*cancel-in-progress:\s*false/);
    assert.match(prepareJob, /GITHUB_REF_TYPE[^\n]*tag/);
    assert.match(prepareJob, /GITHUB_REF_NAME[^\n]*v\$version/);
});

test('one exact tarball is tested before staging', () => {
    assert.equal((workflow.match(/npm pack /g) ?? []).length, 1);
    assert.match(prepareJob, /yarn install --immutable/);
    assert.match(prepareJob, /yarn build/);
    assert.match(prepareJob, /standalone-package-smoke\/run-smoke\.mjs[^\n]*--tarball/);
    assert.match(prepareJob, /createHash\('sha512'\)/);
    assert.match(prepareJob, /upload-artifact@[a-f\d]{40}/);
    assert.doesNotMatch(prepareJob, /yarn quality|yarn test/);
    assert.doesNotMatch(prepareJob, /id-token:\s*write|environment:\s*npm-publish/);
});

test('the protected OIDC job only verifies and stages the retained tarball', () => {
    assert.match(stageJob, /needs:\s*prepare/);
    assert.match(stageJob, /environment:\s*npm-publish/);
    assert.match(stageJob, /id-token:\s*write/);
    assert.match(stageJob, /download-artifact@[a-f\d]{40}/);
    assert.match(stageJob, /npm install --global npm@11\.18\.0/);
    assert.match(stageJob, /createHash\('sha512'\)[\s\S]*test "\$actual" = "\$EXPECTED_SHA512"/);
    assert.equal((stageJob.match(/npm stage publish/g) ?? []).length, 1);
    assert.doesNotMatch(stageJob, /actions\/checkout|yarn |node scripts\/|npm stage (?:list|view|download|approve)|(?:^|\s)npm publish(?:\s|$)|gh run|NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test('release evidence and live-test ceremony stay out of the staging workflow', () => {
    assert.doesNotMatch(workflow, /wsl|live-(?:linux|macos)|platform-evidence|provenance_evidence|staged_verification|artifact-state|verify-platform-evidence/i);
    assert.deepEqual([...workflow.matchAll(/^  (prepare|stage):\s*$/gm)].map(match => match[1]), ['prepare', 'stage']);
});
