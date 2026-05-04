/**
 * Regression test for issue #39: `pathgrade validate` crashes under ESM with
 * `ReferenceError: require is not defined` because `runTsc` in the compiled
 * `dist/commands/validate.js` references a free `require`.
 *
 * The existing src-level tests don't catch this — vitest's transformer makes
 * `require` reachable in source files even when the emitted ESM output has no
 * such binding. To reproduce the user-visible failure we must run the CLI as
 * a real Node subprocess against the compiled `dist/`.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const PKG_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'bin', 'pathgrade.js');
const DIST_ENTRY = path.join(PKG_ROOT, 'dist', 'pathgrade.js');

const VALID_EVAL = `import { describe, it } from 'vitest';
import { createAgent, check, evaluate } from 'pathgrade';

describe('sample', () => {
  it('scores the agent', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 300 });
    await agent.prompt('Read app.js and fix the bug so add(2, 3) returns 5.');
    await evaluate(agent, [
      check('app-exists', () => true),
    ]);
  });
});
`;

describe('pathgrade validate — ESM consumer (issue #39)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/pathgrade.js not found at ${DIST_ENTRY}. ` +
          `Run \`npm run build\` (or \`npm test\`, which compiles first) before this test.`,
      );
    }
  });

  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-validate-esm-'));
  });
  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('runs the CLI from a "type": "module" consumer without a ReferenceError', () => {
    // Simulate an ESM consumer project. `type: module` makes it equivalent
    // to the reporter's repo; no node_modules in here — pathgrade must
    // resolve its own typescript / @types/node.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'esm-consumer', type: 'module', private: true }),
    );
    const evalPath = path.join(tmpDir, 'sample.eval.ts');
    fs.writeFileSync(evalPath, VALID_EVAL);

    const result = spawnSync(process.execPath, [BIN, 'validate', evalPath], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 60000,
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).not.toMatch(/ReferenceError/);
    expect(combined).not.toMatch(/require is not defined/);

    // CLI ran to completion and printed the JSON result.
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(
      expect.objectContaining({
        valid: expect.any(Boolean),
        errors: expect.any(Array),
        warnings: expect.any(Array),
      }),
    );
  }, 70000);
});
