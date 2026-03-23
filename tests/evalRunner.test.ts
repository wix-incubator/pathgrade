import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Mock dependencies
vi.mock('fs-extra', () => ({
  readFile: vi.fn(),
  ensureDir: vi.fn(),
  writeJSON: vi.fn(),
}));

vi.mock('./graders', () => ({
  getGrader: vi.fn(),
}));

import * as fs from 'fs-extra';
import { EvalRunner, EvalRunOptions } from '../src/evalRunner';
import { BaseAgent, EnvironmentProvider, GraderResult } from '../src/types';

const mockRuntime = {
  handle: '/trial',
  workspacePath: '/workspace',
  env: {
    HOME: '/trial/home',
    XDG_CONFIG_HOME: '/trial/xdg',
    XDG_STATE_HOME: '/trial/xdg/state',
    TMPDIR: '/trial/tmp',
  },
};

const mockEnsureDir = vi.mocked(fs.ensureDir);
const mockWriteJSON = vi.mocked(fs.writeJSON);

/** Standard eval options used across tests */
function makeEvalOpts(overrides?: Partial<EvalRunOptions>): EvalRunOptions {
  return {
    instruction: 'Do something',
    graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    timeoutSec: 300,
    environment: { cpus: 2, memory_mb: 2048 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('EvalRunner', () => {
  function makeMockProvider(): EnvironmentProvider {
    return {
      prepare: vi.fn().mockResolvedValue('image-1'),
      setup: vi.fn().mockResolvedValue(mockRuntime),
      cleanup: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
  }

  function makeMockAgent(output = 'Agent done'): BaseAgent {
    return {
      run: vi.fn().mockResolvedValue(output),
    } as any;
  }

  it('runs a single trial and returns report', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();
    const opts = makeEvalOpts();

    const mockGrader = {
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic',
        score: 1.0,
        weight: 1.0,
        details: 'All passed',
      } as GraderResult),
    };

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue(mockGrader);

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], opts, 1);

    expect(report.task).toBe('task');
    expect(report.trials).toHaveLength(1);
    expect(report.trials[0].trial_id).toBe(1);
    expect(report.trials[0].reward).toBe(1.0);
    expect(report.trials[0].session_log.length).toBeGreaterThan(0);
    expect(provider.prepare).toHaveBeenCalled();
    expect(provider.setup).toHaveBeenCalled();
    expect(provider.cleanup).toHaveBeenCalled();
    expect(provider.teardown).toHaveBeenCalled();
  });

  it('uses a session-capable agent when available', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      rawOutput: 'Session raw output',
      assistantMessage: 'Assistant summary',
      exitCode: 0,
    });
    const createSession = vi.fn().mockResolvedValue({
      start,
      reply: vi.fn(),
    });
    const agent = { createSession } as unknown as BaseAgent;

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function));
    expect(start).toHaveBeenCalledWith({ message: 'Do something' });
    expect(report.trials[0].session_log.some(entry => entry.output === 'Session raw output')).toBe(true);
  });

  it('runs scripted multi-turn conversations and stops on done_phrase', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      rawOutput: 'Turn one raw output',
      assistantMessage: 'What is your goal?',
      exitCode: 0,
    });
    const reply = vi.fn().mockResolvedValue({
      rawOutput: 'Turn two raw output',
      assistantMessage: 'Project brief created successfully.',
      exitCode: 0,
    });
    const createSession = vi.fn().mockResolvedValue({ start, reply });
    const agent = { createSession } as unknown as BaseAgent;

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts({
      instruction: undefined,
      conversation: {
        opener: 'Help me start a new project.',
        completion: {
          max_turns: 4,
          done_phrase: 'brief created',
        },
        replies: [
          { content: 'The goal is validating demand quickly.' },
        ],
      },
    }), 1);

    expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ message: 'Help me start a new project.' }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ message: 'The goal is validating demand quickly.' }));
    expect(report.trials[0].conversation).toEqual(expect.objectContaining({
      total_turns: 2,
      completion_reason: 'done_phrase',
    }));
    expect(report.trials[0].conversation?.turns.map(turn => turn.user_message_source)).toEqual(['opener', 'scripted']);
    expect(report.trials[0].session_log.filter(entry => entry.type === 'agent_result')).toHaveLength(2);
  });

  it('falls back to persona replies after scripted replies are exhausted', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      rawOutput: 'Turn one raw output',
      assistantMessage: 'What are you building?',
      exitCode: 0,
    });
    const reply = vi.fn()
      .mockResolvedValueOnce({
        rawOutput: 'Turn two raw output',
        assistantMessage: 'Any technical constraints or repo links?',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        rawOutput: 'Turn three raw output',
        assistantMessage: 'Project brief created.',
        exitCode: 0,
      });
    const createSession = vi.fn().mockResolvedValue({ start, reply });
    const agent = { createSession } as unknown as BaseAgent;

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return {
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'No repo links yet, and I do not know the implementation details.' }] } }],
          usageMetadata: {
            promptTokenCount: 111,
            candidatesTokenCount: 22,
            totalTokenCount: 133,
          },
        }),
      } as any;
    });

    try {
      const runner = new EvalRunner(provider);
      const report = await runner.runEval(agent, '/task', [], makeEvalOpts({
        instruction: undefined,
        conversation: {
          opener: 'Help me start a new project.',
          completion: {
            max_turns: 4,
            done_phrase: 'brief created',
          },
          replies: [
            { content: 'It is a gift card feature for Wix Stores.' },
          ],
          persona: {
            description: 'You are a concise Wix product manager.',
            facts: [
              'The feature is for Wix Stores.',
              'You do not know the technical implementation details.',
            ],
          },
        },
      }), 1, { GEMINI_API_KEY: 'test-key' });

      expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function));
      expect(reply).toHaveBeenNthCalledWith(1, expect.objectContaining({
        message: 'It is a gift card feature for Wix Stores.',
        continueSession: true,
      }));
      expect(reply).toHaveBeenNthCalledWith(2, expect.objectContaining({
        message: 'No repo links yet, and I do not know the implementation details.',
        continueSession: true,
      }));
      expect(report.trials[0].conversation).toEqual(expect.objectContaining({
        total_turns: 3,
        completion_reason: 'done_phrase',
      }));
      expect(report.trials[0].conversation?.turns.map(turn => turn.user_message_source)).toEqual([
        'opener',
        'scripted',
        'persona_llm',
      ]);
      expect(report.trials[0].persona_input_tokens).toBe(111);
      expect(report.trials[0].persona_output_tokens).toBe(22);

      const prompt = capturedBody.contents[0].parts[0].text;
      expect(prompt).toContain('## Who You Are');
      expect(prompt).toContain('You are a concise Wix product manager.');
      expect(prompt).toContain('The feature is for Wix Stores.');
      expect(prompt).toContain('User: Help me start a new project.');
      expect(prompt).toContain('Assistant: What are you building?');
      expect(prompt).toContain("## Agent's Latest Message");
      expect(prompt).toContain('Any technical constraints or repo links?');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('counts multi-turn agent tokens from user and assistant messages, not raw outputs', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      rawOutput: 'This raw output is much longer than the assistant summary',
      assistantMessage: 'Plan',
      exitCode: 0,
    });
    const reply = vi.fn()
      .mockResolvedValueOnce({
        rawOutput: 'Another verbose raw output that should not drive token totals',
        assistantMessage: 'Tech',
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        rawOutput: 'Final verbose raw output for completion',
        assistantMessage: 'Done',
        exitCode: 0,
      });
    const createSession = vi.fn().mockResolvedValue({ start, reply });
    const agent = { createSession } as unknown as BaseAgent;

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Repo' }] } }],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 3,
          totalTokenCount: 10,
        },
      }),
    } as any);

    try {
      const runner = new EvalRunner(provider);
      const report = await runner.runEval(agent, '/task', [], makeEvalOpts({
        instruction: undefined,
        conversation: {
          opener: 'Idea',
          completion: {
            max_turns: 4,
            done_phrase: 'Done',
          },
          replies: [
            { content: 'Gift' },
          ],
          persona: {
            description: 'Short persona',
            facts: ['Fact'],
          },
        },
      }), 1, { GEMINI_API_KEY: 'test-key' });

      expect(report.trials[0].input_tokens).toBe(3);
      expect(report.trials[0].output_tokens).toBe(3);
      expect(report.trials[0].persona_input_tokens).toBe(7);
      expect(report.trials[0].persona_output_tokens).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles agent errors gracefully', async () => {
    const provider = makeMockProvider();
    const agent = {
      run: vi.fn().mockRejectedValue(new Error('Agent crashed')),
    } as any as BaseAgent;

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect(report.trials[0].reward).toBe(0);
    expect(report.trials[0].grader_results).toEqual([]);
  });

  it('aborts agent commands when the agent times out', async () => {
    const provider = makeMockProvider();
    const seenSignals: AbortSignal[] = [];
    (provider.runCommand as any).mockImplementation(
      async (_runtime: unknown, _cmd: string, _env: unknown, options?: { signal?: AbortSignal }) =>
        await new Promise((resolve) => {
          if (options?.signal) {
            seenSignals.push(options.signal);
            options.signal.addEventListener(
              'abort',
              () => resolve({ stdout: '', stderr: 'aborted', exitCode: 124, timedOut: true }),
              { once: true }
            );
          }
        })
    );

    const agent = {
      run: vi.fn().mockImplementation(async (_instruction: string, _workspace: string, runCommand: any) => {
        const res = await runCommand('sleep forever');
        return `Result: ${res.stderr}`;
      }),
    } as any as BaseAgent;

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts({ timeoutSec: 0.01 }), 1);

    expect(report.trials[0].reward).toBe(0);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0].aborted).toBe(true);
    expect(report.trials[0].session_log[report.trials[0].session_log.length - 1].output).toContain('timed out');
  });

  it('saves report to logDir when provided', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider, '/logs');
    await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect(mockEnsureDir).toHaveBeenCalledWith('/logs');
    expect(mockWriteJSON).toHaveBeenCalled();
    const writtenPath = (mockWriteJSON.mock.calls[0] as any[])[0] as string;
    expect(writtenPath).toContain('task_');
    expect(writtenPath).toContain('.json');
  });

  it('sanitizes secrets from report when env passed', async () => {
    const provider = makeMockProvider();
    (provider.runCommand as any).mockResolvedValue({
      stdout: 'The key is MY_SECRET_VALUE_123',
      stderr: '',
      exitCode: 0,
    });
    const agent = {
      run: vi.fn().mockImplementation(async (instruction: string, workspace: string, runCommand: any) => {
        const res = await runCommand('echo test');
        return `Output: ${res.stdout}`;
      }),
    } as any as BaseAgent;

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider, '/logs');
    await runner.runEval(agent, '/task', [], makeEvalOpts(), 1, { SECRET: 'MY_SECRET_VALUE_123' });

    const writtenReport = (mockWriteJSON.mock.calls[0] as any[])[1];
    const reportStr = JSON.stringify(writtenReport);
    expect(reportStr).not.toContain('MY_SECRET_VALUE_123');
    expect(reportStr).toContain('[REDACTED]');
  });

  it('calculates correct pass_rate and pass_at_k', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    let callCount = 0;
    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          grader_type: 'deterministic',
          score: callCount % 2 === 0 ? 1.0 : 0.0,
          weight: 1.0,
          details: 'test',
        };
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 2);

    expect(report.trials).toHaveLength(2);
    // Trial 1 score=0, Trial 2 score=1.0
    expect(report.pass_rate).toBe(0.5);
  });

  it('runs trials in parallel when parallel > 1', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 3, undefined, 2);

    expect(report.trials).toHaveLength(3);
  });

  it('does not save report when logDir is not set', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect(mockWriteJSON).not.toHaveBeenCalled();
  });

  it('calls provider.diagnose on error if available', async () => {
    const provider = makeMockProvider();
    (provider as any).diagnose = vi.fn().mockResolvedValue('Diagnostics output');

    const agent = {
      run: vi.fn().mockRejectedValue(new Error('Failed')),
    } as any as BaseAgent;

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect((provider as any).diagnose).toHaveBeenCalled();
    const lastLogEntry = report.trials[0].session_log[report.trials[0].session_log.length - 1];
    expect(lastLogEntry.output).toContain('Diagnostics output');
  });

  it('handles provider without prepare and teardown', async () => {
    const provider: EnvironmentProvider = {
      setup: vi.fn().mockResolvedValue(mockRuntime),
      cleanup: vi.fn().mockResolvedValue(undefined),
      runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };

    const agent = makeMockAgent();

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], makeEvalOpts(), 1);

    expect(report.trials).toHaveLength(1);
    // Should not throw even without prepare/teardown
  });

  it('handles multiple graders of each type', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const opts = makeEvalOpts({
      graders: [
        { type: 'deterministic', run: 'echo 1', weight: 0.5 },
        { type: 'deterministic', run: 'echo 2', weight: 0.2 },
        { type: 'llm_rubric', rubric: 'Evaluate quality', weight: 0.3 },
      ],
    });

    const gradersModule = await import('../src/graders/index');
    vi.spyOn(gradersModule, 'getGrader').mockReturnValue({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'deterministic', score: 1.0, weight: 1.0, details: 'ok',
      }),
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(agent, '/task', [], opts, 1);

    expect(report.trials[0].grader_results).toHaveLength(3);
  });
});
