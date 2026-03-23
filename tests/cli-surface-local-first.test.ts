import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.join(repoRoot, 'src/pathgrade.ts');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

function getHelpOutput(): string {
  return execFileSync(
    process.execPath,
    ['-r', 'ts-node/register', cliEntry, '--help'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
    }
  );
}

describe('local-first CLI surface', () => {
  it('shows local as the default provider in CLI help', () => {
    const output = getHelpOutput();

    expect(output).toContain('--provider=local|docker');
    expect(output).toContain('default: local');
    expect(output).not.toContain('default: docker');
  });

  it('documents local-first usage in the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('**Prerequisites**: Node.js 20+');
    expect(readme).toContain('--provider=local\\|docker');
    expect(readme).toContain('provider: local');
    expect(readme).not.toContain('**Prerequisites**: Node.js 20+, Docker');
    expect(readme).not.toContain('provider: docker');
    expect(readme).not.toContain('Use `docker` (the default)');
  });

  it('frames the architecture guide around local execution by default', () => {
    const architecture = readRepoFile('docs/ARCHITECTURE.md');

    expect(architecture).toContain('runs trials in isolated local workspaces by default');
    expect(architecture).toContain('provider: local');
    expect(architecture).toContain('--provider=NAME     local | docker');
    expect(architecture).toContain('Local Provider (Default)');
    expect(architecture).not.toContain('provider: docker');
  });
});
