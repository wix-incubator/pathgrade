import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureDir,
  mockWriteFile,
  mockCopy,
  mockRemove,
  mockPathExists,
  mockReadFile,
  mockStat,
  loadEvalConfigMock,
  resolveTaskMock,
  detectSkillsMock,
  createAgentMock,
  localProviderCtor,
  dockerProviderCtor,
  runEvalMock,
} = vi.hoisted(() => ({
  mockEnsureDir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockCopy: vi.fn(),
  mockRemove: vi.fn(),
  mockPathExists: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
  loadEvalConfigMock: vi.fn(),
  resolveTaskMock: vi.fn(),
  detectSkillsMock: vi.fn(),
  createAgentMock: vi.fn(),
  localProviderCtor: vi.fn(),
  dockerProviderCtor: vi.fn(),
  runEvalMock: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  ensureDir: mockEnsureDir,
  writeFile: mockWriteFile,
  copy: mockCopy,
  remove: mockRemove,
  pathExists: mockPathExists,
  readFile: mockReadFile,
  stat: mockStat,
}));

vi.mock('../src/core/config', () => ({
  loadEvalConfig: loadEvalConfigMock,
  resolveTask: resolveTaskMock,
}));

vi.mock('../src/core/skills', () => ({
  detectSkills: detectSkillsMock,
}));

vi.mock('../src/agents/registry', () => ({
  createAgent: createAgentMock,
}));

vi.mock('../src/providers/local', () => ({
  LocalProvider: class LocalProviderMock {
    constructor(...args: unknown[]) {
      localProviderCtor(...args);
      return { kind: 'local-provider' };
    }
  },
}));

vi.mock('../src/providers/docker', () => ({
  DockerProvider: class DockerProviderMock {
    constructor(...args: unknown[]) {
      dockerProviderCtor(...args);
      return { kind: 'docker-provider' };
    }
  },
}));

vi.mock('../src/evalRunner', () => ({
  EvalRunner: vi.fn().mockImplementation(() => ({
    runEval: runEvalMock,
  })),
}));

import { runEvals } from '../src/commands/run';

describe('runEvals local-first runtime path', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockEnsureDir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCopy.mockResolvedValue(undefined);
    mockRemove.mockResolvedValue(undefined);
    mockPathExists.mockResolvedValue(false);
    mockReadFile.mockResolvedValue('');
    mockStat.mockResolvedValue(null);
    detectSkillsMock.mockResolvedValue([]);

    createAgentMock.mockReturnValue({ run: vi.fn().mockResolvedValue('done') });
    runEvalMock.mockResolvedValue({
      task: 'test-task',
      pass_rate: 1,
      pass_at_k: 1,
      pass_pow_k: 1,
      trials: [
        {
          trial_id: 1,
          reward: 1,
          grader_results: [],
          duration_ms: 1,
          n_commands: 0,
          input_tokens: 1,
          output_tokens: 1,
          session_log: [],
        },
      ],
      skills_used: [],
    });

    loadEvalConfigMock.mockResolvedValue({
      defaults: {
        agent: 'gemini',
        provider: 'local',
        trials: 1,
        timeout: 300,
        threshold: 0.8,
        docker: { base: 'node:20-slim' },
        environment: { cpus: 2, memory_mb: 2048 },
      },
      tasks: [{ name: 'test-task' }],
    });

    resolveTaskMock.mockResolvedValue({
      name: 'test-task',
      instruction: 'do it',
      workspace: [],
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1 }],
      agent: 'gemini',
      provider: 'local',
      trials: 1,
      timeout: 300,
      docker: { base: 'node:20-slim' },
      environment: { cpus: 2, memory_mb: 2048 },
    });
  });

  it('uses LocalProvider for the default runtime path', async () => {
    await runEvals('/repo', {});

    expect(localProviderCtor).toHaveBeenCalledTimes(1);
    expect(dockerProviderCtor).not.toHaveBeenCalled();
  });

  it('does not write a Dockerfile when running locally by default', async () => {
    await runEvals('/repo', {});

    const writtenPaths = mockWriteFile.mock.calls.map(call => String(call[0]));
    expect(writtenPaths.some(filePath => filePath.includes('environment/Dockerfile'))).toBe(false);
  });

  it('still prepares Docker artifacts when Docker is requested explicitly', async () => {
    resolveTaskMock.mockResolvedValueOnce({
      name: 'test-task',
      instruction: 'do it',
      workspace: [],
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1 }],
      agent: 'gemini',
      provider: 'docker',
      trials: 1,
      timeout: 300,
      docker: { base: 'node:20-slim' },
      environment: { cpus: 2, memory_mb: 2048 },
    });

    await runEvals('/repo', { provider: 'docker' });

    const writtenPaths = mockWriteFile.mock.calls.map(call => String(call[0]));
    expect(dockerProviderCtor).toHaveBeenCalledTimes(1);
    expect(writtenPaths.some(filePath => filePath.includes('environment/Dockerfile'))).toBe(true);
  });
});
