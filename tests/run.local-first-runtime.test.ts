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

vi.mock('../src/evalRunner', () => ({
  EvalRunner: class EvalRunnerMock {
    runEval = runEvalMock;
  },
}));

import { runEvals } from '../src/commands/run';

describe('runEvals local-first runtime path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        trials: 1,
        timeout: 300,
        threshold: 0.8,
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
      trials: 1,
      timeout: 300,
      environment: { cpus: 2, memory_mb: 2048 },
    });
  });

  it('uses LocalProvider for the default runtime path', async () => {
    await runEvals('/repo', {});

    expect(localProviderCtor).toHaveBeenCalledTimes(1);
  });

  it('does not write a Dockerfile when running locally by default', async () => {
    await runEvals('/repo', {});

    const writtenPaths = mockWriteFile.mock.calls.map(call => String(call[0]));
    expect(writtenPaths.some(filePath => filePath.includes('environment/Dockerfile'))).toBe(false);
  });

  it('passes resolved local-only task settings through to the runner', async () => {
    resolveTaskMock.mockResolvedValueOnce({
      name: 'test-task',
      instruction: 'do it',
      workspace: [],
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1 }],
      agent: 'claude',
      trials: 3,
      timeout: 120,
      environment: { cpus: 2, memory_mb: 2048 },
    });

    await runEvals('/repo', { parallel: 2, agent: 'claude' });

    expect(createAgentMock).toHaveBeenCalledWith('claude');
    expect(runEvalMock).toHaveBeenCalledWith(
      expect.objectContaining({ run: expect.any(Function) }),
      expect.stringContaining('/pathgrade/repo/tmp/test-task'),
      [],
      expect.objectContaining({
        instruction: 'do it',
        timeoutSec: 120,
        environment: { cpus: 2, memory_mb: 2048 },
      }),
      3,
      expect.any(Object),
      2,
    );
  });

  it('passes conversation tasks through with conversation timeout precedence', async () => {
    resolveTaskMock.mockResolvedValueOnce({
      name: 'conversation-task',
      instruction: undefined,
      conversation: {
        opener: 'Help me start a project.',
        completion: {
          max_turns: 4,
          timeout: 45,
        },
        replies: [{ content: 'It is for freelance designers.' }],
      },
      workspace: [],
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1 }],
      agent: 'gemini',
      trials: 1,
      timeout: 300,
      environment: { cpus: 2, memory_mb: 2048 },
    });

    await runEvals('/repo', {});

    expect(runEvalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('/pathgrade/repo/tmp/conversation-task'),
      [],
      expect.objectContaining({
        instruction: undefined,
        conversation: {
          opener: 'Help me start a project.',
          completion: {
            max_turns: 4,
            timeout: 45,
          },
          replies: [{ content: 'It is for freelance designers.' }],
        },
        timeoutSec: 45,
      }),
      1,
      expect.any(Object),
      1,
    );
  });

  it('propagates OPENAI_BASE_URL to the runner environment', async () => {
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = 'https://www.wixapis.com/openai/v1';
    process.env.OPENAI_API_KEY = 'sk-test';

    try {
      await runEvals('/repo', {});

      expect(runEvalMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(Array),
        expect.any(Object),
        1,
        expect.objectContaining({
          OPENAI_API_KEY: 'sk-test',
          OPENAI_BASE_URL: 'https://www.wixapis.com/openai/v1',
        }),
        1,
      );
    } finally {
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl;
      }

      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }
  });
});
