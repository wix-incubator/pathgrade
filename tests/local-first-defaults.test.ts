import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const filesThatShouldBeLocalOnly = [
  'src/commands/init.ts',
  'templates/eval.yaml.template',
  'eval.yaml',
  'examples/angular-modern/eval.yaml',
  'examples/superlint/eval.yaml',
];

describe('local-first defaults', () => {
  it.each(filesThatShouldBeLocalOnly)('%s no longer scaffolds provider/docker config', filePath => {
    const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
    expect(content).not.toContain('provider: local');
    expect(content).not.toContain('docker:');
  });
});
