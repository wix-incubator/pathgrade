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
  it('shows a local-only runtime in CLI help', () => {
    const output = getHelpOutput();

    expect(output).not.toContain('--provider=');
    expect(output).toContain('--agent=NAME');
    expect(output).toContain('Output directory');
  });

  it('documents local-first usage in the README', () => {
    const readme = readRepoFile('README.md');

    expect(readme).toContain('**Prerequisites**: Node.js 20+');
    expect(readme).toContain('Pathgrade runs locally');
    expect(readme).not.toContain('--provider=local\\|docker');
    expect(readme).not.toContain('provider: local');
    expect(readme).not.toContain('docker:');
    expect(readme).not.toContain('**Prerequisites**: Node.js 20+, Docker');
    expect(readme).not.toContain('provider: docker');
    expect(readme).not.toContain('Use `docker` (the default)');
  });

  it('documents tool_usage in README and CLI help', () => {
    const readme = readRepoFile('README.md');
    const output = getHelpOutput();

    expect(readme).toContain('tool_usage');
    expect(output).toContain('tool_usage');
  });

  it('frames the architecture guide around local-only execution', () => {
    const architecture = readRepoFile('docs/ARCHITECTURE.md');

    expect(architecture).toContain('runs trials in isolated local workspaces by default');
    expect(architecture).toContain('local-only runtime');
    expect(architecture).not.toContain('--provider=NAME');
    expect(architecture).not.toContain('DockerProvider');
    expect(architecture).not.toContain('provider: docker');
  });
});
