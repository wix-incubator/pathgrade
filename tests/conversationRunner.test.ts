import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as nativeFs } from 'fs';
import { runConversationTrial } from '../src/conversationRunner';
import { BaseAgent, EnvironmentProvider, AgentCommandRunner, EnvironmentHandle } from '../src/types';
import { ResolvedConversation } from '../src/core/config.types';

// Suppress persona/LLM noise in test output
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockRuntime: EnvironmentHandle = {
  handle: '/trial',
  workspacePath: '/workspace',
  env: {},
};

function makeProvider(): EnvironmentProvider {
  return {
    setup: vi.fn().mockResolvedValue(mockRuntime),
    cleanup: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

/**
 * Build a session-based agent whose start/reply calls return scripted results.
 * Each call to `responses` is consumed in order.
 */
function makeSessionAgent(responses: Array<{ rawOutput: string; assistantMessage: string; exitCode: number }>) {
  let callIndex = 0;
  const start = vi.fn().mockImplementation(async () => {
    return responses[callIndex++] ?? { rawOutput: 'fallback', assistantMessage: 'fallback', exitCode: 0 };
  });
  const reply = vi.fn().mockImplementation(async () => {
    return responses[callIndex++] ?? { rawOutput: 'fallback', assistantMessage: 'fallback', exitCode: 0 };
  });
  const createSession = vi.fn().mockResolvedValue({ start, reply });
  const agent = { createSession } as unknown as BaseAgent;
  return { agent, start, reply, createSession };
}

function makeConversation(overrides: Partial<ResolvedConversation> = {}): ResolvedConversation {
  return {
    opener: 'Hello agent, start the task.',
    completion: {
      max_turns: 5,
    },
    reactions: [],
    ...overrides,
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runConversationTrial', () => {
  describe('completes on max_turns', () => {
    it('stops and returns completion_reason=max_turns when max_turns is reached', async () => {
      const maxTurns = 3;
      // Provide enough responses so we never hit done_phrase — each returns a neutral reply
      const responses = Array.from({ length: maxTurns }, (_, i) => ({
        rawOutput: `Turn ${i + 1} raw`,
        assistantMessage: `Turn ${i + 1} response`,
        exitCode: 0,
      }));
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: maxTurns },
        reactions: [
          { when: '.*', reply: 'Reply 1' },
          { when: '.*', reply: 'Reply 2' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('max_turns');
      expect(result.conversation.total_turns).toBe(maxTurns);
      expect(result.conversation.turns).toHaveLength(maxTurns);
    });

    it('records correct turn numbers in each turn', async () => {
      const responses = [
        { rawOutput: 'a', assistantMessage: 'a', exitCode: 0 },
        { rawOutput: 'b', assistantMessage: 'b', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 2 },
        reactions: [{ when: '.*', reply: 'Keep going' }],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.turns[0].turn_number).toBe(1);
      expect(result.conversation.turns[1].turn_number).toBe(2);
      expect(result.conversation.completion_reason).toBe('max_turns');
    });
  });

  describe('completes on done_phrase', () => {
    it('stops when agent response contains done_phrase', async () => {
      const responses = [
        { rawOutput: 'Working on it...', assistantMessage: 'Working on it...', exitCode: 0 },
        { rawOutput: 'Task complete!', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent, reply } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [{ when: '.*', reply: 'Continue please.' }],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('done_phrase');
      expect(result.conversation.total_turns).toBe(2);
      // Should have stopped after done_phrase, so reply was called once (turn 2)
      expect(reply).toHaveBeenCalledTimes(1);
    });

    it('done_phrase matching is case-insensitive', async () => {
      const responses = [
        { rawOutput: 'TASK COMPLETE', assistantMessage: 'TASK COMPLETE', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('done_phrase');
      expect(result.conversation.total_turns).toBe(1);
    });

    it('first turn opener message source is opener', async () => {
      const responses = [
        { rawOutput: 'Done.', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.turns[0].user_message_source).toBe('opener');
      expect(result.conversation.turns[0].user_message).toBe('Hello agent, start the task.');
    });
  });

  describe('completes on output_path', () => {
    it('stops when the configured output_path already exists in the workspace', async () => {
      const workspacePath = await nativeFs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-output-path-'));
      try {
        await nativeFs.mkdir(path.join(workspacePath, 'artifacts'), { recursive: true });
        await nativeFs.writeFile(path.join(workspacePath, 'artifacts/output.md'), 'done');

        const runtime: EnvironmentHandle = {
          ...mockRuntime,
          workspacePath,
        };
        const responses = [
          { rawOutput: 'Created the output.', assistantMessage: 'Created the output.', exitCode: 0 },
        ];
        const { agent } = makeSessionAgent(responses);
        const provider = makeProvider();
        const conversation = makeConversation({
          completion: { max_turns: 5, output_path: 'artifacts/output.md' },
        });

        const result = await runConversationTrial({
          agent,
          conversation,
          provider,
          runtime,
          taskPath: '/task',
          timeoutSec: 30,
          timestamp,
        });

        expect(result.conversation.completion_reason).toBe('signal');
        expect(result.conversation.total_turns).toBe(1);
      } finally {
        await nativeFs.rm(workspacePath, { recursive: true, force: true });
      }
    });
  });

  describe('ends with no_replies when scripted replies exhausted and no persona', () => {
    it('returns no_replies when reply pool is empty and no persona configured', async () => {
      const responses = [
        { rawOutput: 'First response', assistantMessage: 'First response', exitCode: 0 },
        { rawOutput: 'Second response', assistantMessage: 'Second response', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      // Only 1 scripted reply — after first turn, no more replies and no persona
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [{ when: '.*', reply: 'One scripted reply.', once: true }],
        // no persona
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('no_replies');
      // Turn 1: opener, Turn 2: scripted reply. After turn 2 no more replies.
      expect(result.conversation.total_turns).toBe(2);
    });

    it('returns no_replies with zero scripted replies and no persona on first pickReaction', async () => {
      const responses = [
        { rawOutput: 'Response', assistantMessage: 'Response', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [],
        // no persona
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('no_replies');
      expect(result.conversation.total_turns).toBe(1);
    });

    it('records scripted reply as source in turn log', async () => {
      const responses = [
        { rawOutput: 'Resp 1', assistantMessage: 'Resp 1', exitCode: 0 },
        { rawOutput: 'Resp 2', assistantMessage: 'Resp 2', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [{ when: '.*', reply: 'Scripted reply text' }],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.turns[0].user_message_source).toBe('opener');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      expect(result.conversation.turns[1].user_message).toBe('Scripted reply text');
    });
  });

  describe('uses pattern-matched replies when regex matches', () => {
    it('uses scripted_pattern reply when agent response matches when pattern', async () => {
      const responses = [
        { rawOutput: 'I need to know: what is the budget?', assistantMessage: 'I need to know: what is the budget?', exitCode: 0 },
        { rawOutput: 'Okay, proceeding with the plan.', assistantMessage: 'Okay, proceeding with the plan.', exitCode: 0 },
        { rawOutput: 'Task complete!', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
          { when: '.*', reply: 'The fallback reply' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Turn 2 should use the pattern reply (agent asked about budget)
      const turn2 = result.conversation.turns[1];
      expect(turn2.user_message).toBe('The budget is $500.');
      expect(turn2.user_message_source).toBe('reaction');
      expect(result.conversation.completion_reason).toBe('done_phrase');
    });

    it('reuses the same reaction on multiple matching turns', async () => {
      const responses = [
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
        { rawOutput: 'What is the budget again?', assistantMessage: 'What is the budget again?', exitCode: 0 },
        { rawOutput: 'Task complete!', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Same reaction fires on turns 2 and 3 (reusable by default)
      expect(result.conversation.turns[1].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      expect(result.conversation.turns[2].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[2].user_message_source).toBe('reaction');
    });

    it('once:true reactions fire only once then are skipped', async () => {
      const responses = [
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.', once: true },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Turn 2: once-reaction fires
      expect(result.conversation.turns[1].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      // Turn 2 agent asks about budget again, but once-reaction already used → no_replies
      expect(result.conversation.completion_reason).toBe('no_replies');
      expect(result.conversation.total_turns).toBe(2);
    });

    it('returns no_replies when reactions exist but none match agent response', async () => {
      const responses = [
        { rawOutput: 'Tell me about the timeline.', assistantMessage: 'Tell me about the timeline.', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
          { when: 'team', reply: 'The team is 5 people.' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Agent said "timeline" which matches neither "budget" nor "team", no persona → no_replies
      expect(result.conversation.completion_reason).toBe('no_replies');
      expect(result.conversation.total_turns).toBe(1);
    });
  });

  describe('records timeout when deadline is exceeded', () => {
    it('returns completion_reason=timeout when agent blocks on a command that awaits abort', async () => {
      // The provider.runCommand blocks until the abort signal fires.
      // conversationRunner passes currentSignal to runCommand, so when
      // withAbortTimeout fires the abort, the command resolves and the
      // agent turn is treated as a timeout.
      const provider = makeProvider();
      (provider.runCommand as ReturnType<typeof vi.fn>).mockImplementation(
        async (_runtime: unknown, _cmd: string, _env: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            if (options?.signal) {
              options.signal.addEventListener(
                'abort',
                () => resolve({ stdout: '', stderr: 'aborted', exitCode: 124, timedOut: true }),
                { once: true }
              );
            }
          })
      );

      const createSession = vi.fn().mockImplementation(
        async (_runtime: EnvironmentHandle, runCommand: AgentCommandRunner) => ({
          start: async (_input: unknown) => {
            // Block until the command resolves (which is when abort fires)
            const res = await runCommand('sleep forever');
            return { rawOutput: res.stderr, assistantMessage: '', exitCode: res.exitCode };
          },
          reply: vi.fn(),
        })
      );
      const agent = { createSession } as unknown as BaseAgent;
      const conversation = makeConversation({
        completion: { max_turns: 5 },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 0.05, // 50ms — abort fires, command resolves, turn returns
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('timeout');
      expect(result.conversation.timeout_triggered_at_turn).toBe(1);
    }, 10_000);

    it('returns timeout with zero turns when deadline already passed before loop', async () => {
      const responses = [
        { rawOutput: 'response', assistantMessage: 'response', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5 },
      });

      // Pass a negative timeout so remainingMs <= 0 immediately on first loop iteration
      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: -1,
        timestamp,
      });

      expect(result.conversation.completion_reason).toBe('timeout');
      expect(result.conversation.total_turns).toBe(0);
      expect(result.conversation.timeout_triggered_at_turn).toBe(1);
    });
  });

  describe('session log', () => {
    it('always starts log with agent_start entry containing opener', async () => {
      const responses = [
        { rawOutput: 'Done.', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      const firstLog = result.sessionLog[0];
      expect(firstLog.type).toBe('agent_start');
      expect(firstLog.instruction).toBe('Hello agent, start the task.');
    });

    it('logs user_reply and agent_result for each turn', async () => {
      const responses = [
        { rawOutput: 'Hello back', assistantMessage: 'Hello back', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 1 },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      const userReplyEntries = result.sessionLog.filter(e => e.type === 'user_reply');
      const agentResultEntries = result.sessionLog.filter(e => e.type === 'agent_result');
      expect(userReplyEntries).toHaveLength(1);
      expect(agentResultEntries).toHaveLength(1);
    });
  });

  describe('result shape', () => {
    it('returns correct inputText joining all user messages', async () => {
      const responses = [
        { rawOutput: 'r1', assistantMessage: 'r1', exitCode: 0 },
        { rawOutput: 'Done', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        opener: 'Opener message',
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [{ when: '.*', reply: 'User reply 2' }],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.inputText).toContain('Opener message');
      expect(result.inputText).toContain('User reply 2');
    });

    it('returns commandCount of zero when no commands were run', async () => {
      const responses = [
        { rawOutput: 'Done', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.commandCount).toBe(0);
    });

    it('increments commandCount when provider.runCommand is called', async () => {
      // Agent that runs a command via runCommand
      let capturedRunCommand: AgentCommandRunner | undefined;
      const createSession = vi.fn().mockImplementation(async (_runtime: EnvironmentHandle, runCommand: AgentCommandRunner) => {
        capturedRunCommand = runCommand;
        return {
          start: vi.fn().mockImplementation(async () => {
            await capturedRunCommand!('echo hello');
            await capturedRunCommand!('ls /');
            return { rawOutput: 'done', assistantMessage: 'Task complete!', exitCode: 0 };
          }),
          reply: vi.fn(),
        };
      });
      const agent = { createSession } as unknown as BaseAgent;
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.commandCount).toBe(2);
      expect(provider.runCommand).toHaveBeenCalledTimes(2);
    });

    it('initializes personaInputTokens and personaOutputTokens to zero when no persona', async () => {
      const responses = [
        { rawOutput: 'Done', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.personaInputTokens).toBe(0);
      expect(result.personaOutputTokens).toBe(0);
    });
  });

  describe('turn status', () => {
    it('marks completed turns as turn_status=completed', async () => {
      const responses = [
        { rawOutput: 'Done', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 5, done_phrase: 'task complete' },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      expect(result.conversation.turns[0].turn_status).toBe('completed');
    });

    it('records assistant_message from turn result', async () => {
      const responses = [
        { rawOutput: 'raw output here', assistantMessage: 'polished summary', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 1 },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      const turn = result.conversation.turns[0];
      expect(turn.raw_agent_output).toBe('raw output here');
      expect(turn.assistant_message).toBe('polished summary');
    });
  });

  describe('tool event extraction', () => {
    it('attaches per-turn tool events in conversation runs', async () => {
      const responses = [{
        rawOutput: 'tool: edit_file {"path":"src/app.ts"}',
        assistantMessage: 'edited file',
        exitCode: 0,
        traceOutput: 'tool: edit_file {"path":"src/app.ts"}',
      }];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 1 },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
        agentName: 'codex',
      });

      expect(result.conversation.turns[0].tool_events).toEqual([
        expect.objectContaining({ action: 'edit_file' }),
      ]);
    });

    it('adds tool_event entries to session log', async () => {
      const responses = [{
        rawOutput: 'tool: exec_command {"cmd":"npm test"}',
        assistantMessage: 'tests passed',
        exitCode: 0,
        traceOutput: 'tool: exec_command {"cmd":"npm test"}',
      }];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 1 },
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
        agentName: 'codex',
      });

      const toolEntries = result.sessionLog.filter(e => e.type === 'tool_event');
      expect(toolEntries).toHaveLength(1);
      expect(toolEntries[0].tool_event?.action).toBe('run_shell');
      expect(toolEntries[0].turn_number).toBe(1);
    });
  });
});
