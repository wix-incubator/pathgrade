import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deterministicGrader, llmRubricGrader, toolUsageGrader } from '../src/core/grader-factories';
import { GraderContext } from '../src/core/grader-factories';
import { LLMGrader } from '../src/graders/index';
import { ToolUsageGrader } from '../src/graders/tool-usage';
import { GraderConfig, EnvironmentProvider } from '../src/types';
import { validateConfig } from '../src/core/config';

// Mock fs-extra for LLMGrader rubric loading
vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readFile: vi.fn(),
}));

// Mock CLI so callLLM doesn't try real subprocess in keyless tests
vi.mock('../src/utils/cli-llm', () => ({
  isClaudeCliAvailable: vi.fn().mockResolvedValue(false),
  callClaudeCli: vi.fn(),
}));

import * as fs from 'fs-extra';

const mockPathExists = vi.mocked(fs.pathExists);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function makeProvider(stdout: string, stderr = '', exitCode = 0): EnvironmentProvider {
  return {
    setup: vi.fn(),
    cleanup: vi.fn(),
    runCommand: vi.fn().mockResolvedValue({ stdout, stderr, exitCode }),
  };
}

describe('grader factories', () => {
  it('deterministicGrader returns correct type and default weight', () => {
    const g = deterministicGrader({
      execute: async () => ({ score: 1 }),
    });
    expect(g.type).toBe('deterministic');
    expect(g.weight).toBe(1.0);
    expect(typeof g.execute).toBe('function');
  });

  it('deterministicGrader respects explicit weight', () => {
    const g = deterministicGrader({
      weight: 0.5,
      execute: async () => ({ score: 1 }),
    });
    expect(g.weight).toBe(0.5);
  });

  it('llmRubricGrader returns correct type with rubric', () => {
    const g = llmRubricGrader({ rubric: 'Evaluate quality' });
    expect(g.type).toBe('llm_rubric');
    expect(g.weight).toBe(1.0);
    expect(g.rubric).toBe('Evaluate quality');
  });

  it('llmRubricGrader passes model and include_tool_events', () => {
    const g = llmRubricGrader({
      rubric: 'test',
      model: 'claude-sonnet-4-20250514',
      include_tool_events: true,
      weight: 0.3,
    });
    expect(g.model).toBe('claude-sonnet-4-20250514');
    expect(g.include_tool_events).toBe(true);
    expect(g.weight).toBe(0.3);
  });

  it('toolUsageGrader returns correct type with expectations', () => {
    const expectations = [{ action: 'read_file' as const, min: 1 }];
    const g = toolUsageGrader({ expectations, weight: 0.4 });
    expect(g.type).toBe('tool_usage');
    expect(g.weight).toBe(0.4);
    expect(g.expectations).toBe(expectations);
  });
});

describe('deterministic grader execute dispatch', () => {
  it('calls execute and returns GraderResult', async () => {
    const descriptor = deterministicGrader({
      weight: 0.7,
      execute: async ({ workspacePath }) => ({
        score: 0.8,
        details: `checked ${workspacePath}`,
      }),
    });

    const ctx: GraderContext = {
      workspacePath: '/workspace',
      runCommand: vi.fn(),
      sessionLog: [],
      env: {},
    };

    const output = await descriptor.execute!(ctx);
    expect(output.score).toBe(0.8);
    expect(output.details).toContain('/workspace');
  });

  it('score is clamped to [0, 1] by caller', async () => {
    const descriptor = deterministicGrader({
      execute: async () => ({ score: 2.5 }),
    });
    const ctx: GraderContext = {
      workspacePath: '/w',
      runCommand: vi.fn(),
      sessionLog: [],
      env: {},
    };
    const output = await descriptor.execute!(ctx);
    // Clamping is done by runGraders, not execute itself
    const clamped = Math.max(0, Math.min(1, output.score));
    expect(clamped).toBe(1.0);
  });

  it('runCommand closure delegates to provider', async () => {
    const mockProvider = {
      runCommand: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    };
    const runtime = '/workspace';
    const env = { FOO: 'bar' };
    const signal = new AbortController().signal;

    const ctx: GraderContext = {
      workspacePath: runtime,
      runCommand: (cmd: string) => mockProvider.runCommand(runtime, cmd, env, { signal }),
      sessionLog: [],
      env,
      signal,
    };

    await ctx.runCommand('ls');
    expect(mockProvider.runCommand).toHaveBeenCalledWith('/workspace', 'ls', env, { signal });
  });
});

describe('LLMGrader', () => {
  const grader = new LLMGrader();
  const baseConfig: GraderConfig = { type: 'llm_rubric', rubric: 'rubric.md', weight: 1.0 };

  it('returns score 0 when rubric file not found', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const provider = makeProvider('');
    const result = await grader.grade('/workspace', provider, baseConfig, '/task', []);

    expect(result.score).toBe(0);
    expect(result.details).toContain('Rubric file not found');
  });

  it('returns score 0 when no API key available', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('Evaluate the code quality.' as any);
    const provider = makeProvider('');

    // Use vi.stubEnv to safely remove env vars
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');

    const result = await grader.grade('/workspace', provider, baseConfig, '/task', []);
    expect(result.score).toBe(0);
    expect(result.details).toContain('No LLM backend available');
  });

  it('uses default rubric path when not specified', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const provider = makeProvider('');
    const config: GraderConfig = { type: 'llm_rubric', weight: 1.0 };

    const result = await grader.grade('/workspace', provider, config, '/task', []);
    expect(result.details).toContain('.pathgrade/prompts/quality.md');
  });

  describe('parseResponse (via grade)', () => {
    // Test parseResponse indirectly through callAnthropic
    // We mock fetch to control API responses

    it('parses valid JSON from LLM response', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 0.9, "reasoning": "Great work"}' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        text: () => Promise.resolve(''),
      } as any));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0.9);
      expect(result.details).toBe('Great work');
    });

    it('handles markdown-wrapped JSON in LLM response', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '```json\n{"score": 0.7, "reasoning": "decent"}\n```' }],
        }),
        text: () => Promise.resolve(''),
      } as any));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0.7);
    });

    it('handles empty LLM response', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '' }],
        }),
        text: () => Promise.resolve(''),
      } as any));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0);
      expect(result.details).toContain('Failed to parse');
    });

    it('handles fetch error gracefully', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0);
      expect(result.details).toContain('Anthropic API error');
    });

    it('uses Anthropic API with ANTHROPIC_API_KEY', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 0.85, "reasoning": "good"}' }],
        }),
        text: () => Promise.resolve(''),
      } as any));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0.85);
    });

    it('handles Anthropic fetch error', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Anthropic down')));

      const provider = makeProvider('');
      const env = { ANTHROPIC_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0);
      expect(result.details).toContain('Anthropic API error');
    });

    it('falls back to OpenAI when Anthropic key is missing', async () => {
      mockPathExists.mockResolvedValue(true as any);
      mockReadFile.mockResolvedValue('rubric content' as any);

      vi.stubEnv('ANTHROPIC_API_KEY', '');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '{"score": 0.9, "reasoning": "openai ok"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        text: () => Promise.resolve(''),
      } as any));

      const provider = makeProvider('');
      const env = { OPENAI_API_KEY: 'test-key' };
      const result = await grader.grade('/workspace', provider, baseConfig, '/task', [], env);

      expect(result.score).toBe(0.9);
      expect(result.details).toBe('openai ok');
    });
  });

  it('includes normalized tool events in llm_rubric transcript when include_tool_events is set', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('rubric' as any);

    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return {
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 1.0, "reasoning": "ok"}' }],
        }),
        text: () => Promise.resolve(''),
      };
    }));

    const provider = makeProvider('');
    const sessionLog: import('../src/types').LogEntry[] = [
      { type: 'agent_start', instruction: 'Fix bug', timestamp: '' },
      { type: 'agent_result', output: 'Done!', timestamp: '' },
      { type: 'tool_event', timestamp: '', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...' } },
      { type: 'tool_event', timestamp: '', tool_event: { action: 'read_file', provider: 'codex', providerToolName: 'localGetFileContent', summary: 'read src/app.ts', confidence: 'high', rawSnippet: '...' } },
    ];

    const config: import('../src/types').GraderConfig = {
      type: 'llm_rubric',
      rubric: 'rubric.md',
      weight: 1.0,
      include_tool_events: true,
    } as any;

    const env = { ANTHROPIC_API_KEY: 'test-key' };
    await grader.grade('/workspace', provider, config, '/task', sessionLog, env);

    const prompt = capturedBody.messages[0].content;
    expect(prompt).toContain('Tool Events');
    expect(prompt).toContain('run_shell via exec_command');
    expect(prompt).toContain('read_file via localGetFileContent');
  });

  it('omits tool events from llm_rubric transcript when include_tool_events is not set', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('rubric' as any);

    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return {
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 1.0, "reasoning": "ok"}' }],
        }),
        text: () => Promise.resolve(''),
      };
    }));

    const provider = makeProvider('');
    const sessionLog: import('../src/types').LogEntry[] = [
      { type: 'agent_start', instruction: 'Fix bug', timestamp: '' },
      { type: 'agent_result', output: 'Done!', timestamp: '' },
      { type: 'tool_event', timestamp: '', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...' } },
    ];

    const env = { ANTHROPIC_API_KEY: 'test-key' };
    await grader.grade('/workspace', provider, baseConfig, '/task', sessionLog, env);

    const prompt = capturedBody.messages[0].content;
    expect(prompt).not.toContain('Tool Events');
  });

  it('builds transcript with instruction, commands, agent output, and prior graders', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('rubric' as any);

    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return {
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 1.0, "reasoning": "ok"}' }],
        }),
        text: () => Promise.resolve(''),
      };
    }));

    const provider = makeProvider('');
    const sessionLog: import('../src/types').LogEntry[] = [
      { type: 'agent_start', instruction: 'Do something', timestamp: '' },
      { type: 'command', command: 'ls', stdout: 'file.txt', stderr: '', exitCode: 0, timestamp: '' },
      { type: 'agent_result', output: 'Done!', timestamp: '' },
      { type: 'grader', grader_result: { grader_type: 'deterministic', score: 1.0, weight: 1, details: 'passed' }, timestamp: '' },
    ];

    const env = { ANTHROPIC_API_KEY: 'test-key' };
    await grader.grade('/workspace', provider, baseConfig, '/task', sessionLog, env);

    const prompt = capturedBody.messages[0].content;
    expect(prompt).toContain('Do something');
    expect(prompt).toContain('$ ls');
    expect(prompt).toContain('Done!');
    expect(prompt).toContain('deterministic');
  });

  it('includes the full multi-turn transcript when conversation logs are present', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('rubric' as any);

    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string);
      return {
        ok: true,
        json: () => Promise.resolve({
          content: [{ text: '{"score": 0.8, "reasoning": "covers the whole conversation"}' }],
        }),
        text: () => Promise.resolve(''),
      };
    }));

    const provider = makeProvider('');
    const sessionLog: import('../src/types').LogEntry[] = [
      { type: 'agent_start', instruction: 'Help me start a project.', timestamp: '' },
      { type: 'user_reply', output: 'Help me start a project.', turn_number: 1, reply_source: 'opener', timestamp: '' },
      { type: 'agent_result', output: 'raw turn one', assistant_message: 'What is your goal?', turn_number: 1, timestamp: '' },
      { type: 'user_reply', output: 'Validate demand quickly.', turn_number: 2, reply_source: 'reaction', timestamp: '' },
      { type: 'agent_result', output: 'raw turn two', assistant_message: 'Project brief created.', turn_number: 2, timestamp: '' },
    ];

    const env = { ANTHROPIC_API_KEY: 'test-key' };
    await grader.grade('/workspace', provider, baseConfig, '/task', sessionLog, env);

    const prompt = capturedBody.messages[0].content;
    expect(prompt).toContain('Conversation Transcript');
    expect(prompt).toContain('**User:** Help me start a project.');
    expect(prompt).toContain('**Agent:** What is your goal?');
    expect(prompt).toContain('**User:** Validate demand quickly.');
    expect(prompt).toContain('**Agent:** Project brief created.');
    expect(prompt).toContain('Turn 1');
    expect(prompt).toContain('Turn 2');
  });
});

describe('ToolUsageGrader', () => {
  it('scores tool_usage expectations against normalized tool events', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [
        { action: 'search_code', min: 1, weight: 0.4 },
        { action: 'read_file', min: 1, weight: 0.6 },
      ],
    }, '/task', [
      { type: 'tool_event', timestamp: 't1', tool_event: { action: 'search_code', provider: 'codex', providerToolName: 'localSearchCode', summary: 'search', confidence: 'high', rawSnippet: '...' } },
      { type: 'tool_event', timestamp: 't2', tool_event: { action: 'read_file', provider: 'codex', providerToolName: 'localGetFileContent', summary: 'read', confidence: 'high', rawSnippet: '...' } },
    ]);

    expect(result.score).toBe(1);
    expect(result.grader_type).toBe('tool_usage');
  });

  it('returns score 0 when no tool events captured', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [{ action: 'run_shell', min: 1 }],
    }, '/task', []);

    expect(result.score).toBe(0);
    expect(result.details).toContain('No tool events captured');
  });

  it('returns partial score when some expectations fail', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [
        { action: 'run_shell', min: 1, weight: 0.5 },
        { action: 'read_file', min: 1, weight: 0.5 },
      ],
    }, '/task', [
      { type: 'tool_event', timestamp: 't1', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...' } },
    ]);

    expect(result.score).toBe(0.5);
  });

  it('matches argument_pattern regex against tool arguments', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [
        { action: 'run_shell', argument_pattern: 'npm\\s+test', min: 1, weight: 1 },
      ],
    }, '/task', [
      { type: 'tool_event', timestamp: 't1', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...', arguments: { cmd: 'npm test' } } },
      { type: 'tool_event', timestamp: 't2', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'ls', confidence: 'high', rawSnippet: '...', arguments: { cmd: 'ls -la' } } },
    ]);

    expect(result.score).toBe(1);
  });

  it('fails argument_pattern when no argument values match the regex', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [
        { action: 'run_shell', argument_pattern: 'pytest', min: 1, weight: 1 },
      ],
    }, '/task', [
      { type: 'tool_event', timestamp: 't1', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...', arguments: { cmd: 'npm test' } } },
    ]);

    expect(result.score).toBe(0);
  });

  it('checks max constraint on expectations', async () => {
    const grader = new ToolUsageGrader();
    const result = await grader.grade('/workspace', makeProvider(''), {
      type: 'tool_usage',
      weight: 1,
      expectations: [
        { action: 'ask_user', max: 0, weight: 1 },
      ],
    }, '/task', [
      { type: 'tool_event', timestamp: 't1', tool_event: { action: 'ask_user', provider: 'codex', providerToolName: 'ask_user', summary: 'asked', confidence: 'high', rawSnippet: '...' } },
    ]);

    expect(result.score).toBe(0);
  });
});

describe('config validation for grader descriptors', () => {
  it('throws when deterministic grader is missing execute', () => {
    expect(() => {
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'deterministic', weight: 1.0 }],
        }],
      });
    }).toThrow('must have an "execute" function');
  });

  it('throws when llm_rubric grader is missing rubric', () => {
    expect(() => {
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'llm_rubric', weight: 1.0 }],
        }],
      });
    }).toThrow('must have a "rubric" string');
  });

  it('throws when tool_usage grader is missing expectations', () => {
    expect(() => {
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'tool_usage', weight: 1.0 }],
        }],
      });
    }).toThrow('must have an "expectations" array');
  });
});
