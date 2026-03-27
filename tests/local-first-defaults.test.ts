import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const filesThatShouldBeLocalOnly = [
  'src/commands/init.ts',
  'templates/eval.ts.template',
  'pathgrade.eval.ts',
  'examples/angular-modern/angular-modern.eval.ts',
  'examples/superlint/superlint.eval.ts',
];

describe('local-first defaults', () => {
  it.each(filesThatShouldBeLocalOnly)('%s no longer scaffolds provider/docker config', filePath => {
    const content = fs.readFileSync(path.join(repoRoot, filePath), 'utf-8');
    expect(content).not.toContain('provider: local');
    expect(content).not.toContain('provider: docker');
  });
});
