import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { runValidate } from '../src/commands/validate.js';

describe('pathgrade validate', () => {
  let tmpDir: string;
  let stdout: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-validate-'));
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(tmpDir);
  });

  function getOutput(): any {
    return JSON.parse(stdout.join(''));
  }

  const VALID_EVAL = `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';

describe('my-eval', () => {
  it('scores the agent', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 300 });
    await agent.prompt('Read app.js and fix the bug so add(2, 3) returns 5.');
    const result = await evaluate(agent, [
      check('app-exists', ({ workspace }) => true),
      judge('quality', { rubric: 'Was the fix correct?', weight: 0.3 }),
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
`;

  it('returns valid: true for a well-formed eval file', async () => {
    const evalPath = path.join(tmpDir, 'my.eval.ts');
    await fs.writeFile(evalPath, VALID_EVAL);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('errors when file does not exist', async () => {
    const evalPath = path.join(tmpDir, 'nonexistent.eval.ts');

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.errors[0].check).toBe('file-exists');
  });

  it('errors when file does not have .eval.ts extension', async () => {
    const evalPath = path.join(tmpDir, 'my-test.ts');
    await fs.writeFile(evalPath, VALID_EVAL);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors[0].check).toBe('file-extension');
  });

  it('errors when no pathgrade import found', async () => {
    const evalPath = path.join(tmpDir, 'bad.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it } from 'vitest';
describe('test', () => { it('works', () => {}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'imports-pathgrade')).toBe(true);
  });

  it('errors when no describe/it blocks found', async () => {
    const evalPath = path.join(tmpDir, 'no-describe.eval.ts');
    await fs.writeFile(evalPath, `import { createAgent, evaluate, check } from '@wix/pathgrade';
const agent = createAgent({ agent: 'claude' });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'has-describe-it')).toBe(true);
  });

  it('errors when no createAgent call found', async () => {
    const evalPath = path.join(tmpDir, 'no-agent.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it } from 'vitest';
import { evaluate, check } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const result = await evaluate({} as any, [check('x', () => true)]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'has-create-agent')).toBe(true);
  });

  it('errors when no evaluate call found', async () => {
    const evalPath = path.join(tmpDir, 'no-evaluate.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it } from 'vitest';
import { createAgent, check } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude' });
  await agent.prompt('Do something long enough to pass validation check');
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'has-evaluate')).toBe(true);
  });

  it('errors when no deterministic scorer found', async () => {
    const evalPath = path.join(tmpDir, 'no-check.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it, expect } from 'vitest';
import { createAgent, judge, evaluate } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude', timeout: 300 });
  await agent.prompt('Do something long enough to pass validation check');
  const result = await evaluate(agent, [
    judge('quality', { rubric: 'Was it good?', weight: 1.0 }),
  ]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'has-deterministic-scorer')).toBe(true);
  });

  it('warns on filename consistency violation', async () => {
    const evalPath = path.join(tmpDir, 'inconsistent.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude', timeout: 300 });
  await agent.prompt('Fix the bug in the application code here please.');
  const result = await evaluate(agent, [
    check('output-exists', ({ workspace }) => {
      return require('fs').existsSync(workspace + '/output.txt');
    }),
    judge('quality', { rubric: 'Was it good?', weight: 0.3 }),
  ]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    // Warnings don't cause failure
    expect(exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: any) => w.check === 'filename-consistency')).toBe(true);
    expect(result.warnings[0].message).toContain('output.txt');
  });

  it('passes filename consistency when instruction mentions the file', async () => {
    const evalPath = path.join(tmpDir, 'consistent.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude', timeout: 300 });
  await agent.prompt('Create output.txt with the results of your analysis.');
  const result = await evaluate(agent, [
    check('output-exists', ({ workspace }) => {
      return require('fs').existsSync(workspace + '/output.txt');
    }),
    judge('quality', { rubric: 'Was it good?', weight: 0.3 }),
  ]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('errors when scorer has empty name', async () => {
    const evalPath = path.join(tmpDir, 'empty-name.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude', timeout: 300 });
  await agent.prompt('Do something long enough to pass validation check');
  const result = await evaluate(agent, [
    check('', () => true),
    judge('quality', { rubric: 'Was it good?', weight: 0.3 }),
  ]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'scorer-names-non-empty')).toBe(true);
  });

  it('errors when instruction is too short', async () => {
    const evalPath = path.join(tmpDir, 'short-instruction.eval.ts');
    await fs.writeFile(evalPath, `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';
describe('test', () => { it('works', async () => {
  const agent = await createAgent({ agent: 'claude', timeout: 300 });
  await agent.prompt('Fix it');
  const result = await evaluate(agent, [
    check('done', () => true),
    judge('quality', { rubric: 'Was it good?', weight: 0.3 }),
  ]);
}); });
`);

    const exitCode = await runValidate(evalPath, { skipTsc: true });
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.errors.some((e: any) => e.check === 'instruction-non-empty')).toBe(true);
  });

  it('passes typescript-compiles for eval files using Node builtins (fs, path, __dirname)', async () => {
    // Write eval file in an isolated temp dir — simulates a consumer's project
    // where @types/node is NOT installed locally. The validate command must still
    // resolve Node builtins using pathgrade's own bundled @types/node.
    const evalPath = path.join(tmpDir, 'node-builtins.eval.ts');
    await fs.writeFile(evalPath, `import * as fs from 'fs';
import * as path from 'path';

const dir = __dirname;
const file = path.join(dir, 'test.txt');
const exists: boolean = fs.existsSync(file);
`);

    // Run from the isolated temp dir so tsc can't find node_modules from cwd
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const exitCode = await runValidate(evalPath);
      const result = getOutput();

      // The tsc check must pass — Node builtins must compile without consumer installing @types/node
      expect(result.errors.filter((e: any) => e.check === 'typescript-compiles')).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  }, 30000);
});
