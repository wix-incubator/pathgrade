import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';
import { prepareTempTaskDir } from '../src/commands/run';
import { ResolvedTask } from '../src/core/config.types';
import { deterministicGrader, llmRubricGrader } from '../src/core/grader-factories';

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
      graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      agent: 'claude',
      trials: 1,
      timeout: 300,
      environment: { cpus: 2, memory_mb: 2048 },
      ...overrides,
    } as ResolvedTask;
  }

  it('stages LLM rubric files into .pathgrade/prompts/', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved = makeResolvedTask({
      graders: [
        llmRubricGrader({ rubric: 'Evaluate code quality.', weight: 0.5 }),
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    const rubric = await fsExtra.readFile(path.join(tmpDir, '.pathgrade', 'prompts', 'quality.md'), 'utf-8');
    expect(rubric).toBe('Evaluate code quality.');
  });

  it('does NOT place grader artifacts at the workspace root', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved = makeResolvedTask({
      graders: [
        deterministicGrader({ weight: 0.5, execute: async () => ({ score: 1 }) }),
        llmRubricGrader({ rubric: 'rubric text', weight: 0.5 }),
      ],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // Prompts should NOT exist at the root level
    expect(await fsExtra.pathExists(path.join(tmpDir, 'prompts'))).toBe(false);

    // LLM rubric should be inside .pathgrade/prompts/
    expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade', 'prompts', 'quality.md'))).toBe(true);
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

  it('stages step grader LLM rubrics into .pathgrade/prompts/steps/', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const resolved: ResolvedTask = {
      ...makeResolvedTask(),
      type: 'conversation' as const,
      graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      conversation: {
        opener: 'Hello',
        completion: { max_turns: 4 },
        step_graders: [
          {
            after_turn: 1,
            graders: [
              deterministicGrader({ weight: 0.5, execute: async () => ({ score: 1 }) }),
              llmRubricGrader({ rubric: 'Turn 1 rubric', weight: 0.5 }),
            ],
          },
        ],
      },
    };

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    // Grader index 1 is llm_rubric → .md in prompts/steps/
    const stepRubric = await fsExtra.readFile(
      path.join(tmpDir, '.pathgrade', 'prompts', 'steps', 'turn_1_1.md'), 'utf-8'
    );
    expect(stepRubric).toBe('Turn 1 rubric');
  });
});
