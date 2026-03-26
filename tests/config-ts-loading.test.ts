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
          instruction: 'from typescript',
          graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
        }],
      };
    `);

    const config = await loadEvalConfig(tmpDir);
    expect(config.tasks[0].name).toBe('ts-task');
    expect(config.tasks[0].instruction).toBe('from typescript');
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.trials).toBe(5);
  });

  it('prefers eval.ts over eval.yaml when both exist', async () => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(path.join(tmpDir, 'eval.ts'), `
      export default {
        version: '1',
        tasks: [{
          name: 'from-ts',
          instruction: 'typescript wins',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        }],
      };
    `);
    fs.writeFileSync(path.join(tmpDir, 'eval.yaml'), `
version: "1"
tasks:
  - name: from-yaml
    instruction: yaml loses
    graders:
      - type: deterministic
        run: "echo ok"
`);

    const config = await loadEvalConfig(tmpDir);
    expect(config.tasks[0].name).toBe('from-ts');
  });

  it('throws when eval.ts does not exist (no yaml fallback)', async () => {
    tmpDir = makeTmpDir();
    await expect(loadEvalConfig(tmpDir)).rejects.toThrow('No eval.ts found');
  });
});
