import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(__dirname, '..');
const binEntry = path.join(packageRoot, 'bin/pathgrade.js');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), 'utf-8');
}

function getHelpOutput(): string {
  return execFileSync(
    process.execPath,
    [binEntry, '--help'],
    {
      cwd: packageRoot,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
    }
  );
}

describe('local-first CLI surface', () => {
  it('shows vitest-based usage in CLI help', () => {
    const output = getHelpOutput();

    expect(output).toContain('pathgrade run');
    expect(output).toContain('pathgrade preview-reactions');
    expect(output).toContain('PATHGRADE_AGENT');
    expect(output).not.toContain('--provider=');
  });

  it('documents local-first usage in the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('**Prerequisites**: Node.js 20.');
    expect(readme).toContain('Evaluate AI coding agents with Vitest.');
    expect(readme).toContain('createAgent(');
    expect(readme).toContain('evaluate(');
    expect(readme).not.toContain('--provider=local\\|docker');
    expect(readme).not.toContain('provider: local');
    expect(readme).not.toContain('docker:');
    expect(readme).not.toContain('**Prerequisites**: Node.js 20+, Docker');
    expect(readme).not.toContain('provider: docker');
    expect(readme).not.toContain('Use `docker` (the default)');
  });
});
