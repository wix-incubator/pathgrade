import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);
const resultsPath = path.join(root, '.pathgrade', 'results.json');
const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

assert.equal(report.status, 'pass');
assert.equal(report.overall_pass_rate, 1);
assert.equal(report.groups.length, 1);
assert.equal(report.groups[0].pass_rate, 1);
assert.equal(report.groups[0].trials.length, 1);
assert.equal(report.groups[0].trials[0].reward, 1);
assert.equal(
    report.groups[0].trials[0].name,
    'records deterministic Pathgrade evaluation metadata from a Jest test',
);

const tracePath = path.join(root, '.pathgrade', report.groups[0].trace_file);
const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));

assert.equal(trace.length, 1);
assert.equal(trace[0].reward, 1);
assert.equal(
    trace[0].name,
    'records deterministic Pathgrade evaluation metadata from a Jest test',
);
