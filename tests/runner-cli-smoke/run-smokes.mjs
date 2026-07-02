import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliPath = path.join(repoRoot, 'dist/pathgrade.js');

const smokes = [
    {
        name: 'default Vitest adapter',
        cwd: fixture('vitest-basic'),
        args: ['run'],
    },
    {
        name: 'explicit Vitest adapter',
        cwd: fixture('vitest-basic'),
        args: ['run', '--adapter=vitest'],
    },
    {
        name: 'Jest adapter without node_modules/.bin on PATH',
        cwd: path.join(repoRoot, 'tests/fixtures/jest-adapter'),
        args: ['run', '--adapter=jest', '--', '--config', 'jest.config.mjs', '--runInBand'],
        env: {
            NODE_OPTIONS: '--experimental-vm-modules',
            PATH: systemPathWithoutNodeModulesBin(),
        },
    },
    {
        name: 'Jest adapter captures metadata from worker runs',
        cwd: path.join(repoRoot, 'tests/fixtures/jest-adapter'),
        args: ['run', '--adapter=jest', '--', '--config', 'jest.config.mjs', '--maxWorkers=2'],
        env: {
            NODE_OPTIONS: '--experimental-vm-modules',
            PATH: systemPathWithoutNodeModulesBin(),
        },
        assertReport(report) {
            const scores = report.groups
                .flatMap(group => group.trials)
                .map(trial => trial.reward)
                .sort();

            assert.deepEqual(scores, [0.5, 1]);
        },
    },
    {
        name: 'node-test adapter',
        cwd: fixture('node-test'),
        args: ['run', '--adapter=node-test'],
    },
    {
        name: 'changed selection',
        cwd: fixture('changed-selection'),
        args: ['run', '--changed', '--changed-files=changed-files.txt'],
        assertReport(report) {
            assert.equal(report.selection.changed_files_count, 1);
            assert.deepEqual(report.selection.selected, ['selected.eval.ts']);
            assert.equal(report.groups.length, 1);
            assert.ok(report.groups[0].task.startsWith('selected.eval.ts'));
        },
    },
];

for (const smoke of smokes) {
    runSmoke(smoke);
}

function runSmoke(smoke) {
    cleanArtifacts(smoke.cwd);

    const result = spawnSync(process.execPath, [cliPath, ...smoke.args], {
        cwd: smoke.cwd,
        env: {
            ...process.env,
            PATHGRADE_AGENT: 'codex',
            ...smoke.env,
        },
        encoding: 'utf8',
    });

    assert.equal(
        result.status,
        0,
        [
            `${smoke.name} exited ${result.status}`,
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
        ].join('\n'),
    );

    const report = readReport(smoke.cwd);
    assert.equal(report.status, 'pass', `${smoke.name} report status`);
    assert.ok(report.groups.length > 0, `${smoke.name} should write at least one group`);
    smoke.assertReport?.(report);
    cleanArtifacts(smoke.cwd);
}

function fixture(name) {
    return path.join(repoRoot, 'tests/fixtures/runner-cli-smoke', name);
}

function cleanArtifacts(cwd) {
    fs.rmSync(path.join(cwd, '.pathgrade'), { recursive: true, force: true });
    fs.rmSync(path.join(cwd, 'node_modules/.cache'), { recursive: true, force: true });
    fs.rmSync(path.join(cwd, 'node_modules/.vite'), { recursive: true, force: true });
    removeIfEmpty(path.join(cwd, 'node_modules'));
}

function readReport(cwd) {
    return JSON.parse(
        fs.readFileSync(path.join(cwd, '.pathgrade/results.json'), 'utf8'),
    );
}

function systemPathWithoutNodeModulesBin() {
    return (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(entry => entry && !entry.includes(`node_modules${path.sep}.bin`))
        .join(path.delimiter);
}

function removeIfEmpty(dir) {
    try {
        fs.rmdirSync(dir);
    } catch (err) {
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTEMPTY') throw err;
    }
}
