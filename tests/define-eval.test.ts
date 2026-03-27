import { describe, it, expect } from 'vitest';
import { defineEval } from '../src/core/define-eval';
import { deterministicGrader } from '../src/core/grader-factories';

describe('defineEval', () => {
  it('returns a valid EvalConfig with minimal input', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test-task',
          type: 'instruction',
          instruction: 'do something',
          graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
        },
      ],
    });

    expect(config.version).toBe('1');
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.environment.cpus).toBe(2);
    expect(config.defaults.environment.memory_mb).toBe(2048);
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });

  it('accepts full config with all overrides', () => {
    const config = defineEval({
      version: '2',
      skillPath: './skills/my-skill',
      defaults: {
        agent: 'claude',
        trials: 10,
        timeout: 600,
        threshold: 0.9,
        environment: { cpus: 4, memory_mb: 4096 },
      },
      tasks: [
        {
          name: 'full-task',
          type: 'instruction',
          instruction: 'do everything',
          workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
          graders: [
            deterministicGrader({ weight: 0.7, execute: async () => ({ score: 1 }) }),
            { type: 'llm_rubric', rubric: 'check quality', weight: 0.3 },
          ],
          solution: 'solutions/solve.sh',
          agent: 'codex',
          trials: 20,
        },
      ],
    });

    expect(config.version).toBe('2');
    expect(config.skillPath).toBe('./skills/my-skill');
    expect(config.defaults.agent).toBe('claude');
    expect(config.defaults.environment.cpus).toBe(4);
    expect(config.tasks[0].agent).toBe('codex');
    expect(config.tasks[0].trials).toBe(20);
    expect(config.tasks[0].graders[0].weight).toBe(0.7);
    expect(config.tasks[0].graders[1].type).toBe('llm_rubric');
    expect(config.tasks[0].workspace).toHaveLength(1);
    expect(config.tasks[0].solution).toBe('solutions/solve.sh');
  });

  it('throws when tasks array is empty', () => {
    expect(() => defineEval({ tasks: [] })).toThrow('at least one task');
  });

  it('throws when task is missing name', () => {
    expect(() =>
      defineEval({
        tasks: [{ name: '', type: 'instruction', instruction: 'x', graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })] }],
      })
    ).toThrow('missing a "name"');
  });

  it('throws when task is missing type', () => {
    expect(() =>
      defineEval({
        tasks: [{ name: 'x', graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })] } as any],
      })
    ).toThrow('missing a "type"');
  });

  it('throws when task has no graders', () => {
    expect(() =>
      defineEval({ tasks: [{ name: 'x', type: 'instruction', instruction: 'x', graders: [] }] })
    ).toThrow('at least one grader');
  });

  it('defaults grader weight to 1.0 when omitted', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test',
          type: 'instruction',
          instruction: 'do it',
          graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
        },
      ],
    });

    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });

  it('merges partial environment config with defaults', () => {
    const config = defineEval({
      defaults: { environment: { cpus: 4, memory_mb: 2048 } },
      tasks: [
        {
          name: 'test',
          type: 'instruction',
          instruction: 'do it',
          graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
        },
      ],
    });

    expect(config.defaults.environment.cpus).toBe(4);
    expect(config.defaults.environment.memory_mb).toBe(2048);
  });

  it('supports conversation tasks', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'chat-task',
          type: 'conversation',
          conversation: {
            opener: 'Hello agent',
            completion: { max_turns: 3 },
            replies: [{ content: 'thanks' }],
          },
          graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
        },
      ],
    });

    const task = config.tasks[0] as import('../src/core/config.types').ConversationTaskConfig;
    expect(task.type).toBe('conversation');
    expect(task.conversation.opener).toBe('Hello agent');
    expect(task.conversation.completion.max_turns).toBe(3);
    expect(task.conversation.replies).toHaveLength(1);
  });

  it('supports conversation tasks with persona', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'persona-task',
          type: 'conversation',
          conversation: {
            opener: 'Start here',
            completion: { max_turns: 5 },
            persona: {
              description: 'You are a product manager.',
              facts: ['The feature is for mobile'],
            },
          },
          graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
        },
      ],
    });

    const task = config.tasks[0] as import('../src/core/config.types').ConversationTaskConfig;
    expect(task.conversation.persona?.description).toBe('You are a product manager.');
    expect(task.conversation.persona?.facts).toHaveLength(1);
  });

  it('supports tool_usage graders with expectations', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'tool-task',
          type: 'instruction',
          instruction: 'fix it',
          graders: [{
            type: 'tool_usage',
            weight: 0.5,
            expectations: [
              { action: 'run_shell', min: 1 },
              { action: 'read_file', min: 1, max: 3 },
            ],
          }],
        },
      ],
    });

    expect(config.tasks[0].graders[0].type).toBe('tool_usage');
    expect(config.tasks[0].graders[0].expectations).toHaveLength(2);
  });
});
