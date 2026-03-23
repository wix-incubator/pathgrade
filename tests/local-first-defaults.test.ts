import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const filesThatShouldDefaultToLocal = [
  'src/commands/init.ts',
  'templates/eval.yaml.template',
  'eval.yaml',
  'examples/angular-modern/eval.yaml',
  'examples/superlint/eval.yaml',
];

describe('local-first defaults', () => {
  it.each(filesThatShouldDefaultToLocal)('%s defaults to the local provider', filePath => {
    const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
    expect(content).toContain('provider: local');
  });
});
