import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';
import { prepareTempTaskDir } from '../src/commands/run';
import { ResolvedTask } from '../src/core/config.types';
import { deterministicGrader, llmRubricGrader } from '../src/core/grader-factories';
import { mockMcpServer } from '../src/core/mcp-mock';
import { MockMcpServerDescriptor } from '../src/core/mcp-mock.types';

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

  it('applies symbolic +x chmod when staging workspace files', async () => {
    const baseDir = makeBaseDir();
    const tmpDir = makeTmpDir();
    await fsExtra.ensureDir(baseDir);

    const scriptPath = path.join(baseDir, 'bin', 'tool.sh');
    await fsExtra.ensureDir(path.dirname(scriptPath));
    await fsExtra.writeFile(scriptPath, '#!/bin/sh\necho ok\n');
    await fsExtra.chmod(scriptPath, 0o644);

    const resolved = makeResolvedTask({
      workspace: [{ src: 'bin/tool.sh', dest: 'usr/local/bin/tool', chmod: '+x' }],
    });

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    const stagedPath = path.join(tmpDir, 'usr', 'local', 'bin', 'tool');
    const stat = await fsExtra.stat(stagedPath);
    expect(stat.mode & 0o111).toBe(0o111);
  });

  it('stages step grader assets into .pathgrade/ namespaced subdirectories', async () => {
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

describe('prepareTempTaskDir mcp_mock', () => {
  it('generates fixture and MCP config for mcp_mock', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const mock = mockMcpServer({
      name: 'weather-api',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const resolved = {
      type: 'instruction' as const,
      name: 'mock-test',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_mock: mock,
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);

      // Check fixture file
      const fixturePath = path.join(tmpDir, '.pathgrade-mcp-mock-weather-api.json');
      expect(await fsExtra.pathExists(fixturePath)).toBe(true);
      const fixture = await fsExtra.readJson(fixturePath);
      expect(fixture.name).toBe('weather-api');
      expect(fixture.tools[0].name).toBe('get_weather');

      // Check MCP config
      const mcpConfig = await fsExtra.readJson(path.join(tmpDir, '.pathgrade-mcp.json'));
      expect(mcpConfig.mcpServers['weather-api']).toBeDefined();
      expect(mcpConfig.mcpServers['weather-api'].command).toBe('node');
      expect(mcpConfig.mcpServers['weather-api'].args).toHaveLength(2);
      // First arg: absolute path to mock server script
      expect(path.isAbsolute(mcpConfig.mcpServers['weather-api'].args[0])).toBe(true);
      // Second arg: absolute path to fixture
      expect(path.isAbsolute(mcpConfig.mcpServers['weather-api'].args[1])).toBe(true);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });

  it('generates multiple fixtures for array mcp_mock', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const mocks: MockMcpServerDescriptor[] = [
      mockMcpServer({ name: 'weather', tools: [{ name: 'get_weather', response: 72 }] }),
      mockMcpServer({ name: 'user-db', tools: [{ name: 'get_user', response: { id: 1 } }] }),
    ];

    const resolved = {
      type: 'instruction' as const,
      name: 'multi-mock',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_mock: mocks,
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);

      const mcpConfig = await fsExtra.readJson(path.join(tmpDir, '.pathgrade-mcp.json'));
      expect(Object.keys(mcpConfig.mcpServers)).toEqual(['weather', 'user-db']);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });

  it('does not generate MCP config when mcp_mock is absent', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const resolved = {
      type: 'instruction' as const,
      name: 'no-mock',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);
      expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade-mcp.json'))).toBe(false);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });

  it('throws on duplicate server names', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const mocks: MockMcpServerDescriptor[] = [
      mockMcpServer({ name: 'weather', tools: [{ name: 'a', response: 1 }] }),
      mockMcpServer({ name: 'weather', tools: [{ name: 'b', response: 2 }] }),
    ];

    const resolved = {
      type: 'instruction' as const,
      name: 'dup-mock',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_mock: mocks,
    };

    try {
      await expect(prepareTempTaskDir(resolved as any, '/base', tmpDir)).rejects.toThrow(/duplicate/i);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });
});
