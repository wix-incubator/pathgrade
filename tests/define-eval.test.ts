import { describe, it, expect } from 'vitest';
import { defineEval } from '../src/core/define-eval';

describe('defineEval', () => {
  it('returns a valid EvalConfig with minimal input', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test-task',
          instruction: 'do something',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
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
      skill: './skills/my-skill',
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
          instruction: 'do everything',
          workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
          graders: [
            { type: 'deterministic', run: 'echo ok', weight: 0.7 },
            { type: 'llm_rubric', rubric: 'check quality', weight: 0.3 },
          ],
          solution: 'solutions/solve.sh',
          agent: 'codex',
          trials: 20,
        },
      ],
    });

    expect(config.version).toBe('2');
    expect(config.skill).toBe('./skills/my-skill');
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
        tasks: [{ name: '', instruction: 'x', graders: [{ type: 'deterministic', run: 'x' }] }],
      })
    ).toThrow('missing a "name"');
  });

  it('throws when task is missing instruction and conversation', () => {
    expect(() =>
      defineEval({
        tasks: [{ name: 'x', graders: [{ type: 'deterministic', run: 'x' }] }],
      })
    ).toThrow('missing an "instruction"');
  });

  it('throws when task has no graders', () => {
    expect(() =>
      defineEval({ tasks: [{ name: 'x', instruction: 'x', graders: [] }] })
    ).toThrow('at least one grader');
  });

  it('defaults grader weight to 1.0 when omitted', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test',
          instruction: 'do it',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
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
          instruction: 'do it',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
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
          conversation: {
            opener: 'Hello agent',
            completion: { max_turns: 3 },
            replies: [{ content: 'thanks' }],
          },
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    expect(config.tasks[0].instruction).toBeUndefined();
    expect(config.tasks[0].conversation?.opener).toBe('Hello agent');
    expect(config.tasks[0].conversation?.completion.max_turns).toBe(3);
    expect(config.tasks[0].conversation?.replies).toHaveLength(1);
  });

  it('supports conversation tasks with persona', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'persona-task',
          conversation: {
            opener: 'Start here',
            completion: { max_turns: 5 },
            persona: {
              description: 'You are a product manager.',
              facts: ['The feature is for mobile'],
            },
          },
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    expect(config.tasks[0].conversation?.persona?.description).toBe('You are a product manager.');
    expect(config.tasks[0].conversation?.persona?.facts).toHaveLength(1);
  });
});
