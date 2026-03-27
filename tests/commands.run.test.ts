import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';
import { prepareTempTaskDir } from '../src/commands/run';
import { ResolvedTask } from '../src/core/config.types';

describe('prepareTempTaskDir path traversal', () => {
  it('rejects workspace src that escapes project directory', async () => {
    // Use a deep nested baseDir so ../.. actually resolves to a real location
    const parentDir = path.join(os.tmpdir(), `pathgrade-traversal-${Date.now()}`);
    const baseDir = path.join(parentDir, 'project', 'subdir');
    const tmpDir = path.join(parentDir, 'output');
    await fsExtra.ensureDir(baseDir);
    await fsExtra.ensureDir(tmpDir);

    // Create a "sensitive" file in the parent directory (outside baseDir)
    const sensitiveFile = path.join(parentDir, 'sensitive.txt');
    await fsExtra.writeFile(sensitiveFile, 'sensitive data');

    const resolved: ResolvedTask = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'test',
      // ../../sensitive.txt from baseDir resolves to parentDir/sensitive.txt (outside baseDir)
      workspace: [{ src: '../../sensitive.txt', dest: 'passwd' }],
      graders: [],
      agent: 'gemini' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 1, memory_mb: 512 },
    };

    // Should not copy files from outside baseDir
    await prepareTempTaskDir(resolved, baseDir, tmpDir);
    const files = await fsExtra.readdir(tmpDir);
    // With path traversal, the file could land as 'passwd' (via dest) or 'sensitive.txt' (via basename)
    // Neither should be present
    const nonHidden = files.filter(f => f !== '.pathgrade');
    expect(nonHidden).not.toContain('passwd');
    expect(nonHidden).not.toContain('sensitive.txt');

    await fsExtra.remove(parentDir);
  });
});

describe('prepareTempTaskDir', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      try { await fsExtra.remove(dir); } catch {}
    }
    tempDirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = path.join(os.tmpdir(), `pathgrade-prep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(dir);
    return dir;
  }

  function makeBaseDir(): string {
    const dir = makeTmpDir();
    return dir;
  }

  function makeResolvedTask(overrides?: Record<string, any>): ResolvedTask {
    return {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'do it',
      workspace: [],
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
      agent: 'claude',
      trials: 1,
      timeout: 300,
      environment: { cpus: 2, memory_mb: 2048 },
      ...overrides,
    } as ResolvedTask;
  }

  it('stages deterministic grader scripts into .pathgrade/tests/', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved = makeResolvedTask({
      graders: [
        { type: 'deterministic', run: 'echo "hello"', weight: 0.7 },
        { type: 'deterministic', run: 'node check.js', weight: 0.3 },
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    const testSh = await fsExtra.readFile(path.join(tmpDir, '.pathgrade', 'tests', 'test.sh'), 'utf-8');
    expect(testSh).toContain('echo "hello"');

    const test1Sh = await fsExtra.readFile(path.join(tmpDir, '.pathgrade', 'tests', 'test_1.sh'), 'utf-8');
    expect(test1Sh).toContain('node check.js');
  });

  it('stages LLM rubric files into .pathgrade/prompts/', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved = makeResolvedTask({
      graders: [
        { type: 'llm_rubric', rubric: 'Evaluate code quality.', weight: 0.5 },
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    const rubric = await fsExtra.readFile(path.join(tmpDir, '.pathgrade', 'prompts', 'quality.md'), 'utf-8');
    expect(rubric).toBe('Evaluate code quality.');
  });

  it('does NOT place grader scripts at the workspace root', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved = makeResolvedTask({
      graders: [
        { type: 'deterministic', run: 'echo ok', weight: 0.5 },
        { type: 'llm_rubric', rubric: 'rubric text', weight: 0.5 },
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // These should NOT exist at the root level
    expect(await fsExtra.pathExists(path.join(tmpDir, 'tests'))).toBe(false);
    expect(await fsExtra.pathExists(path.join(tmpDir, 'prompts'))).toBe(false);

    // They should be inside .pathgrade/
    expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade', 'tests', 'test.sh'))).toBe(true);
    expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade', 'prompts', 'quality.md'))).toBe(true);
  });

  it('copies referenced grader directories to the workspace root', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    // Create a grader file that the script references
    await fsExtra.ensureDir(path.join(baseDir, 'graders'));
    await fsExtra.writeFile(path.join(baseDir, 'graders', 'check-brief.js'), 'console.log("grader")');

    const resolved = makeResolvedTask({
      graders: [
        { type: 'deterministic', run: 'node graders/check-brief.js', weight: 1.0 },
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // The graders/ directory should be at workspace root (not in .pathgrade/)
    // because the grader script references it as a relative path
    const graderFile = path.join(tmpDir, 'graders', 'check-brief.js');
    expect(await fsExtra.pathExists(graderFile)).toBe(true);
    const content = await fsExtra.readFile(graderFile, 'utf-8');
    expect(content).toBe('console.log("grader")');
  });

  it('copies workspace files to the tmpDir root', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    // Create a fixture file
    await fsExtra.ensureDir(path.join(baseDir, 'fixtures'));
    await fsExtra.writeFile(path.join(baseDir, 'fixtures', 'input.txt'), 'fixture data');

    const resolved = makeResolvedTask({
      workspace: [{ src: 'fixtures/input.txt', dest: 'input.txt' }],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // Workspace files are copied by basename to the root
    expect(await fsExtra.pathExists(path.join(tmpDir, 'input.txt'))).toBe(true);
  });

  it('copies workspace files using dest path', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);
    await fsExtra.writeFile(path.join(baseDir, 'original-name.js'), 'content');

    const resolved = makeResolvedTask({
      workspace: [{ src: 'original-name.js', dest: 'renamed.js' }],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    expect(await fsExtra.pathExists(path.join(tmpDir, 'renamed.js'))).toBe(true);
    expect(await fsExtra.pathExists(path.join(tmpDir, 'original-name.js'))).toBe(false);
  });

  it('stages step grader assets into .pathgrade/ namespaced subdirectories', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved: ResolvedTask = {
      ...makeResolvedTask(),
      type: 'conversation' as const,
      graders: [{ type: 'deterministic', run: 'echo final', weight: 1.0 }],
      conversation: {
        opener: 'Hello',
        completion: { max_turns: 4 },
        step_graders: [
          {
            after_turn: 1,
            graders: [
              { type: 'deterministic', run: 'echo step1', weight: 0.5 },
              { type: 'llm_rubric', rubric: 'Turn 1 rubric', weight: 0.5 },
            ],
          },
        ],
      },
    };

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // Grader index 0 is deterministic → .sh, index 1 is llm_rubric → .md
    const stepScript = await fsExtra.readFile(
      path.join(tmpDir, '.pathgrade', 'tests', 'steps', 'turn_1_0.sh'), 'utf-8'
    );
    expect(stepScript).toContain('echo step1');

    const stepRubric = await fsExtra.readFile(
      path.join(tmpDir, '.pathgrade', 'prompts', 'steps', 'turn_1_1.md'), 'utf-8'
    );
    expect(stepRubric).toBe('Turn 1 rubric');
  });
});
