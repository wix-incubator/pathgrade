import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock dependencies
vi.mock('fs-extra', () => ({
  readFile: vi.fn(),
  ensureDir: vi.fn(),
  writeJSON: vi.fn(),
  move: vi.fn(),
}));

vi.mock('../src/graders', () => ({
  LLMGrader: vi.fn().mockImplementation(() => ({
    grade: vi.fn().mockResolvedValue({
      grader_type: 'llm_rubric',
      score: 0.8,
      weight: 1.0,
      details: 'ok',
    }),
  })),
}));

vi.mock('../src/graders/tool-usage', () => ({
  ToolUsageGrader: vi.fn().mockImplementation(() => ({
    grade: vi.fn().mockResolvedValue({
      grader_type: 'tool_usage',
      score: 1.0,
      weight: 1.0,
      details: 'ok',
    }),
  })),
}));

// Force tests to use API-key path instead of Claude CLI
vi.mock('../src/utils/cli-llm', () => ({
  isClaudeCliAvailable: vi.fn().mockResolvedValue(false),
  callClaudeCli: vi.fn(),
}));

import * as fs from 'fs-extra';
import { EvalRunner, EvalRunOptions } from '../src/evalRunner';
import { AgentCommandRunner, BaseAgent, EnvironmentProvider } from '../src/types';
import { deterministicGrader, llmRubricGrader } from '../src/core/grader-factories';
import { LLMGrader } from '../src/graders';
import { ToolUsageGrader } from '../src/graders/tool-usage';

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
    graders: [deterministicGrader({ weight: 1.0, execute: async () => ({ score: 1.0 }) })],
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    return new class extends BaseAgent {
      override run(_instruction: string, _workspacePath: string, _runCommand: AgentCommandRunner) {
        return Promise.resolve(output);
      }
    }();
  }

  it('runs a single trial and returns report', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();
    const opts = makeEvalOpts();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], opts, 1);

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

  it('does not fail the eval when provider cleanup throws after a completed trial', async () => {
    const provider = makeMockProvider();
    provider.cleanup = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' }));
    const agent = makeMockAgent();
    const opts = makeEvalOpts();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], opts, 1);

    expect(report.pass_rate).toBe(1);
    expect(provider.cleanup).toHaveBeenCalledTimes(1);
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

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

    expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function), undefined);
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

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({
      instruction: undefined,
      conversation: {
        opener: 'Help me start a new project.',
        completion: {
          max_turns: 4,
          done_phrase: 'brief created',
        },
        reactions: [
          { when: '.*', reply: 'The goal is validating demand quickly.' },
        ],
      },
    }), 1);

    expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function), undefined);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ message: 'Help me start a new project.' }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ message: 'The goal is validating demand quickly.' }));
    expect(report.trials[0].conversation).toEqual(expect.objectContaining({
      total_turns: 2,
      completion_reason: 'done_phrase',
    }));
    expect(report.trials[0].conversation?.turns.map(turn => turn.user_message_source)).toEqual(['opener', 'reaction']);
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

    let capturedBody: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ text: 'No repo links yet, and I do not know the implementation details.' }],
          usage: {
            input_tokens: 111,
            output_tokens: 22,
          },
        }),
        text: async () => '',
      } as any;
    }));

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({
      instruction: undefined,
      conversation: {
        opener: 'Help me start a new project.',
        completion: {
          max_turns: 4,
          done_phrase: 'brief created',
        },
        reactions: [
          { when: '.*', reply: 'It is a gift card feature for Wix Stores.', once: true },
        ],
        persona: {
          description: 'You are a concise Wix product manager.',
          facts: [
            'The feature is for Wix Stores.',
            'You do not know the technical implementation details.',
          ],
        },
      },
    }), 1, { ANTHROPIC_API_KEY: 'test-key' });

    expect(createSession).toHaveBeenCalledWith(mockRuntime, expect.any(Function), undefined);
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
      'reaction',
      'persona_llm',
    ]);
    expect(report.trials[0].persona_input_tokens).toBe(111);
    expect(report.trials[0].persona_output_tokens).toBe(22);

    const prompt = capturedBody.messages[0].content;
    expect(prompt).toContain('## Who You Are');
    expect(prompt).toContain('You are a concise Wix product manager.');
    expect(prompt).toContain('The feature is for Wix Stores.');
    expect(prompt).toContain('User: Help me start a new project.');
    expect(prompt).toContain('Assistant: What are you building?');
    expect(prompt).toContain("## Agent's Latest Message");
    expect(prompt).toContain('Any technical constraints or repo links?');
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

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'Repo' }],
        usage: {
          input_tokens: 7,
          output_tokens: 3,
        },
      }),
      text: async () => '',
    } as any));

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({
      instruction: undefined,
      conversation: {
        opener: 'Idea',
        completion: {
          max_turns: 4,
          done_phrase: 'Done',
        },
        reactions: [
          { when: '.*', reply: 'Gift', once: true },
        ],
        persona: {
          description: 'Short persona',
          facts: ['Fact'],
        },
      },
    }), 1, { ANTHROPIC_API_KEY: 'test-key' });

    expect(report.trials[0].input_tokens).toBe(3);
    expect(report.trials[0].output_tokens).toBe(3);
    expect(report.trials[0].persona_input_tokens).toBe(7);
    expect(report.trials[0].persona_output_tokens).toBe(3);
  });

  it('retries conversation turn once on transient empty response with non-zero exit', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      // First attempt: transient failure (empty response + non-zero exit)
      rawOutput: '', assistantMessage: '', exitCode: 1,
    });
    let replyCallCount = 0;
    const reply = vi.fn().mockImplementation(async () => {
      replyCallCount++;
      if (replyCallCount === 1) {
        // Retry of turn 1 succeeds (uses reply since session was already started)
        return { rawOutput: 'Hello!', assistantMessage: 'Hello!', exitCode: 0 };
      }
      // Turn 2
      return { rawOutput: 'Done.', assistantMessage: 'Project brief created.', exitCode: 0 };
    });
    const createSession = vi.fn().mockResolvedValue({ start, reply });
    const agent = { createSession } as unknown as BaseAgent;

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({
      instruction: undefined,
      conversation: {
        opener: 'Start project.',
        completion: {
          max_turns: 4,
          done_phrase: 'brief created',
        },
        reactions: [
          { when: '.*', reply: 'Continue.' },
        ],
      },
    }), 1);

    // start called once (failed), then reply called for retry + turn 2
    expect(start).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    // Should still complete successfully
    expect(report.trials[0].conversation?.completion_reason).toBe('done_phrase');
    expect(report.trials[0].conversation?.total_turns).toBe(2);
    // The retry log entry should be present
    const retryLog = report.trials[0].session_log.find(
      entry => entry.type === 'agent_result' && entry.output?.includes('retry:')
    );
    expect(retryLog).toBeDefined();
  });

  it('handles agent errors gracefully', async () => {
    const provider = makeMockProvider();
    const agent = new class extends BaseAgent {
      override run(_instruction: string, _workspace: string, _runCommand: AgentCommandRunner) {
        return Promise.reject(new Error('Agent crashed'));
      }
    }();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

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

    const agent = new class extends BaseAgent {
      override async run(_instruction: string, _workspace: string, runCommand: AgentCommandRunner) {
        const res = await runCommand('sleep forever');
        return `Result: ${res.stderr}`;
      }
    }();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({ timeoutSec: 0.01 }), 1);

    expect(report.trials[0].reward).toBe(0);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0].aborted).toBe(true);
    expect(report.trials[0].session_log[report.trials[0].session_log.length - 1].output).toContain('timed out');
  });

  it('saves report to logDir when provided', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const runner = new EvalRunner(provider, '/logs');
    await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

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
    const agent = new class extends BaseAgent {
      override async run(_instruction: string, _workspace: string, runCommand: AgentCommandRunner) {
        const res = await runCommand('echo test');
        return `Output: ${res.stdout}`;
      }
    }();

    const runner = new EvalRunner(provider, '/logs');
    await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1, { SECRET: 'MY_SECRET_VALUE_123' });

    const writtenReport = (mockWriteJSON.mock.calls[0] as any[])[1];
    const reportStr = JSON.stringify(writtenReport);
    expect(reportStr).not.toContain('MY_SECRET_VALUE_123');
    expect(reportStr).toContain('[REDACTED]');
  });

  it('calculates correct pass_rate and pass_at_k', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    let callCount = 0;
    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({
      graders: [deterministicGrader({
        weight: 1.0,
        execute: async () => {
          callCount++;
          return { score: callCount % 2 === 0 ? 1.0 : 0.0, details: 'test' };
        },
      })],
    }), 2);

    expect(report.trials).toHaveLength(2);
    // Trial 1 score=0, Trial 2 score=1.0
    expect(report.pass_rate).toBe(0.5);
  });

  it('runs trials in parallel when parallel > 1', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 3, undefined, 2);

    expect(report.trials).toHaveLength(3);
  });

  it('does not save report when logDir is not set', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const runner = new EvalRunner(provider);
    await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

    expect(mockWriteJSON).not.toHaveBeenCalled();
  });

  it('calls provider.diagnose on error if available', async () => {
    const provider = makeMockProvider();
    (provider as any).diagnose = vi.fn().mockResolvedValue('Diagnostics output');

    const agent = new class extends BaseAgent {
      override run(_instruction: string, _workspacePath: string, _runCommand: AgentCommandRunner) {
        return Promise.reject(new Error('Failed'));
      }
    }();

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

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

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts(), 1);

    expect(report.trials).toHaveLength(1);
    // Should not throw even without prepare/teardown
  });

  it('passes abort signal to grader on timeout', async () => {
    let receivedSignal: AbortSignal | undefined;

    const mockProvider = {
      setup: vi.fn().mockResolvedValue({ handle: '/tmp/test', workspacePath: '/tmp/test/workspace', env: {} }),
      cleanup: vi.fn().mockResolvedValue(undefined),
      runCommand: vi.fn(async (_ws: any, _cmd: string, _env: any, options?: any) => {
        receivedSignal = options?.signal;
        // Simulate a slow grader -- wait for abort
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ stdout: '{"score": 1}', stderr: '', exitCode: 0 }), 10000);
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve({ stdout: '', stderr: '', exitCode: 124, timedOut: true });
            });
          }
        });
      }),
    };

    const runner = new EvalRunner(mockProvider as any);
    const report = await runner.runEval(
      () => makeMockAgent('output'),
      '/tmp/task',
      [],
      {
        instruction: 'test',
        graders: [deterministicGrader({
          weight: 1,
          execute: async (ctx) => {
            // Simulate a slow grader that uses runCommand (which will be aborted)
            await ctx.runCommand('sleep 999');
            return { score: 1 };
          },
        })],
        timeoutSec: 60,
        graderTimeoutSec: 0.1, // 100ms grader timeout
        environment: { cpus: 1, memory_mb: 512 },
      },
      1,
      {},
    );

    // The grader should have received an abort signal
    expect(receivedSignal).toBeDefined();
    expect(report.trials[0].reward).toBe(0);
  });

  it('preserves passing grader results when a later grader fails', async () => {
    const mockProvider = makeMockProvider();

    // Make LLMGrader throw to simulate API failure
    vi.mocked(LLMGrader).mockImplementation(() => ({
      grade: vi.fn().mockRejectedValue(new Error('LLM API failed')),
    }) as any);

    const runner = new EvalRunner(mockProvider);
    const report = await runner.runEval(
      () => makeMockAgent('output'),
      '/tmp/task',
      [],
      {
        instruction: 'test',
        graders: [
          deterministicGrader({ weight: 1.0, execute: async () => ({ score: 1.0, details: 'passed' }) }),
          llmRubricGrader({ rubric: 'rubric.md', weight: 1.0 }),
        ],
        timeoutSec: 60,
        environment: { cpus: 1, memory_mb: 512 },
      },
      1,
      {},
    );

    // First grader passed, second failed -- reward should be 0.5 not 0
    expect(report.trials[0].grader_results).toHaveLength(2);
    expect(report.trials[0].grader_results[0].score).toBe(1.0);
    expect(report.trials[0].grader_results[1].score).toBe(0);
    expect(report.trials[0].reward).toBe(0.5);
  });

  it('handles multiple graders of each type', async () => {
    const provider = makeMockProvider();
    const agent = makeMockAgent();

    const opts = makeEvalOpts({
      graders: [
        deterministicGrader({ weight: 0.5, execute: async () => ({ score: 1.0 }) }),
        deterministicGrader({ weight: 0.2, execute: async () => ({ score: 1.0 }) }),
        llmRubricGrader({ rubric: 'Evaluate quality', weight: 0.3 }),
      ],
    });

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], opts, 1);

    expect(report.trials[0].grader_results).toHaveLength(3);
  });

  it('calculates weighted reward from multiple graders', async () => {
    const mockProvider = makeMockProvider();

    // Make LLMGrader return score 0
    vi.mocked(LLMGrader).mockImplementation(() => ({
      grade: vi.fn().mockResolvedValue({
        grader_type: 'llm_rubric',
        score: 0.0,
        weight: 0.3,
        details: 'test',
      }),
    }) as any);

    const runner = new EvalRunner(mockProvider);
    const report = await runner.runEval(
      () => makeMockAgent('output'),
      '/tmp/task',
      [],
      {
        instruction: 'test',
        graders: [
          deterministicGrader({ weight: 0.7, execute: async () => ({ score: 1.0, details: 'test' }) }),
          llmRubricGrader({ rubric: 'rubric.md', weight: 0.3 }),
        ],
        timeoutSec: 60,
        environment: { cpus: 1, memory_mb: 512 },
      },
      1,
      {},
    );

    // deterministic scored 1.0 (weight 0.7), llm scored 0.0 (weight 0.3)
    // weighted reward = (1.0 * 0.7 + 0.0 * 0.3) / (0.7 + 0.3) = 0.7
    expect(report.trials[0].reward).toBeCloseTo(0.7);
    expect(report.trials[0].grader_results[0].weight).toBe(0.7);
    expect(report.trials[0].grader_results[1].weight).toBe(0.3);
  });

  it('records normalized tool_event entries for instruction trials', async () => {
    const provider = makeMockProvider();
    const start = vi.fn().mockResolvedValue({
      rawOutput: 'tool: exec_command {"cmd":"npm test"}',
      assistantMessage: 'ran tests',
      exitCode: 0,
      traceOutput: 'tool: exec_command {"cmd":"npm test"}',
    });
    const createSession = vi.fn().mockResolvedValue({ start, reply: vi.fn() });
    const agent = { createSession } as unknown as BaseAgent;

    const runner = new EvalRunner(provider);
    const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({ agentName: 'codex' }), 1);
    const toolEntries = report.trials[0].session_log.filter(entry => entry.type === 'tool_event');
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0].tool_event?.action).toBe('run_shell');
  });
});
