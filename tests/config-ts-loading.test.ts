/**
 * Tests for eval.ts loading via jiti.
 * Separate file to avoid module-level fs-extra mock from config.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEvalConfig } from '../src/core/config';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-test-'));
}

function cleanTmpDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('loadEvalConfig with eval.ts', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanTmpDir(tmpDir);
  });

  it('loads eval.ts when it exists', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'eval.ts'), `
      export default {
        version: '1',
        tasks: [{
          name: 'ts-task',
          type: 'instruction',
          instruction: 'from typescript',
          graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
        }],
      };
    `);

    const config = await loadEvalConfig(tmpDir);
    expect(config.tasks[0].name).toBe('ts-task');
    expect((config.tasks[0] as any).instruction).toBe('from typescript');
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.trials).toBe(5);
  });

  it('loads eval.ts regardless of other files present', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'eval.ts'), `
      export default {
        version: '1',
        tasks: [{
          name: 'from-ts',
          type: 'instruction',
          instruction: 'typescript wins',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        }],
      };
    `);
    fs.writeFileSync(path.join(tmpDir, 'some-other-file.txt'), 'irrelevant');

    const config = await loadEvalConfig(tmpDir);
    expect(config.tasks[0].name).toBe('from-ts');
  });

  it('throws when eval.ts does not exist (no yaml fallback)', async () => {
    tmpDir = makeTmpDir();
    await expect(loadEvalConfig(tmpDir)).rejects.toThrow('No eval.ts found');
  });

  it('loads the repository eval.ts config', async () => {
    const repoDir = path.resolve(__dirname, '..');

    const config = await loadEvalConfig(repoDir);

    expect(config.tasks.map(task => task.name)).toEqual([
      'create-eval-config',
      'write-deterministic-grader',
    ]);
  });

  it('loads package-backed example evals from a source checkout', async () => {
    const repoDir = path.resolve(__dirname, '..');

    const toolUsageConfig = await loadEvalConfig(path.join(repoDir, 'examples', 'tool-usage'));
    const strategyConfig = await loadEvalConfig(path.join(repoDir, 'examples', 'ck-product-strategy'));

    expect(toolUsageConfig.tasks.map(task => task.name)).toEqual(['tool-aware-fix']);
    expect(strategyConfig.tasks.map(task => task.name)).toEqual([
      'scripted-smart-cart',
      'persona-smart-cart',
    ]);
  });
});
