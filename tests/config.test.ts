import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateConfig, resolveTask } from '../src/core/config';
import { EvalTaskConfig, EvalDefaults, ConversationTaskConfig, ResolvedInstructionTask, ResolvedConversationTask } from '../src/core/config.types';

// Mock fs-extra for resolveTask tests only (file reference resolution)
vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from 'fs-extra';

const mockPathExists = vi.mocked(fs.pathExists);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('validateConfig', () => {
  it('throws when config is not an object', () => {
    expect(() => validateConfig(null)).toThrow('must be an object');
    expect(() => validateConfig('string')).toThrow('must be an object');
  });

  it('throws when tasks array is missing', () => {
    expect(() => validateConfig({ version: '1' })).toThrow('at least one task');
  });

  it('throws when tasks array is empty', () => {
    expect(() => validateConfig({ version: '1', tasks: [] })).toThrow('at least one task');
  });

  it('throws when task is missing name', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ type: 'instruction', instruction: 'do something', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('missing a "name"');
  });

  it('rejects task without type field', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', instruction: 'do it', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('missing a "type"');
  });

  it('rejects instruction task without instruction field', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'instruction', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('missing an "instruction"');
  });

  it('rejects conversation task without conversation block', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'conversation', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('missing a "conversation"');
  });

  it('rejects invalid task type', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'unknown', instruction: 'do it', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('missing a "type"');
  });

  it('accepts conversation tasks without instruction', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: {
          opener: 'Start here',
          completion: { max_turns: 3 },
          replies: [{ content: 'First reply' }],
        },
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    const task0 = config.tasks[0] as ConversationTaskConfig;
    expect(task0.conversation).toEqual({
      opener: 'Start here',
      completion: { max_turns: 3 },
      replies: [{ content: 'First reply' }],
    });
  });

  it('accepts conversation tasks with persona fallback and no scripted replies', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: {
          opener: 'Start here',
          completion: { max_turns: 3 },
          persona: {
            description: 'You are a concise product manager.',
            facts: ['The feature is for Wix Stores', 'You do not know the implementation details'],
          },
        },
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    const task0 = config.tasks[0] as ConversationTaskConfig;
    expect(task0.conversation).toEqual({
      opener: 'Start here',
      completion: { max_turns: 3 },
      persona: {
        description: 'You are a concise product manager.',
        facts: ['The feature is for Wix Stores', 'You do not know the implementation details'],
      },
    });
  });

  it('rejects conversation tasks with neither scripted replies nor persona', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: { opener: 'Start here', completion: { max_turns: 3 } },
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    })).toThrow('must include at least one of "replies" or "persona"');
  });

  it('throws when task has no graders', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do something' }],
    })).toThrow('at least one grader');
  });

  it('throws on workspace mapping without src/dest', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do something',
        workspace: [{ foo: 'bar' }],
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    })).toThrow('without src/dest');
  });

  it('parses valid config correctly', () => {
    const config = validateConfig({
      version: '1',
      skillPath: './SKILL.md',
      defaults: { agent: 'claude', trials: 10 },
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'install the app',
        graders: [
          { type: 'deterministic', run: 'echo ok', weight: 0.7 },
          { type: 'llm_rubric', rubric: 'check quality', weight: 0.3 },
        ],
      }],
    });
    expect(config.version).toBe('1');
    expect(config.skillPath).toBe('./SKILL.md');
    expect(config.defaults.agent).toBe('claude');
    expect(config.defaults.trials).toBe(10);
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].graders[0].weight).toBe(0.7);
    expect(config.tasks[0].graders[1].type).toBe('llm_rubric');
  });

  it('applies default values when defaults not specified', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.environment).toEqual({ cpus: 2, memory_mb: 2048 });
  });

  it('rejects deprecated defaults.provider', () => {
    expect(() => validateConfig({
      version: '1',
      defaults: { provider: 'local' },
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('defaults.provider');
  });

  it('rejects deprecated defaults.docker', () => {
    expect(() => validateConfig({
      version: '1',
      defaults: { docker: { base: 'node:20-slim' } },
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('defaults.docker');
  });

  it('rejects deprecated task-level provider and docker fields', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        provider: 'docker',
        docker: { base: 'node:20-slim' },
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    })).toThrow('Task "test-task" uses deprecated');
  });

  it('handles workspace string shorthand', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: ['fixtures/app.js'],
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { src: 'fixtures/app.js', dest: 'app.js' },
    ]);
  });

  it('handles workspace objects with chmod', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: [{ src: 'scripts/run.sh', dest: '/workspace/run.sh', chmod: '+x' }],
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { src: 'scripts/run.sh', dest: '/workspace/run.sh', chmod: '+x' },
    ]);
  });

  it('passes through done_when in conversation completion config', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: {
          opener: 'Start here',
          completion: {
            max_turns: 5,
            done_when: 'The agent has delivered a complete project brief',
          },
          replies: [{ content: 'ok' }],
        },
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    const task = config.tasks[0] as ConversationTaskConfig;
    expect(task.conversation.completion.done_when)
      .toBe('The agent has delivered a complete project brief');
  });

  it('rejects invalid agent name in defaults', () => {
    expect(() => validateConfig({
      version: '1',
      defaults: { agent: 'unknown-agent' },
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', run: 'echo ok' }] }],
    })).toThrow('Invalid agent');
  });

  it('rejects invalid agent name in task override', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        agent: 'unknown-agent',
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    })).toThrow('Invalid agent');
  });

  it('defaults grader weight to 1.0', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        graders: [{ type: 'deterministic', run: 'echo ok' }],
      }],
    });
    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });
});

describe('resolveTask', () => {
  const defaults: EvalDefaults = {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    environment: { cpus: 2, memory_mb: 2048 },
  };

  it('applies defaults when task has no overrides', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'line 1\nline 2',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.agent).toBe('gemini');
    expect(resolved.trials).toBe(5);
    expect(resolved.timeout).toBe(300);
    expect(resolved.environment).toEqual({ cpus: 2, memory_mb: 2048 });
  });

  it('task overrides take precedence over defaults', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'line 1\nline 2',
      agent: 'claude',
      trials: 10,
      timeout: 600,
      environment: { memory_mb: 4096 },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.agent).toBe('claude');
    expect(resolved.trials).toBe(10);
    expect(resolved.timeout).toBe(600);
    expect(resolved.environment).toEqual({ cpus: 2, memory_mb: 4096 });
  });

  it('keeps inline multi-line instruction as-is', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'line 1\nline 2\nline 3',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedInstructionTask;
    expect(resolved.instruction).toBe('line 1\nline 2\nline 3');
  });

  it('resolves instruction from file when it exists', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'instruction.md',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('File content here' as any);

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedInstructionTask;
    expect(resolved.instruction).toBe('File content here');
  });

  it('resolves deterministic grader run from file', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline instruction',
      graders: [{ type: 'deterministic', run: 'test.sh', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('#!/bin/bash\necho pass' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].run).toBe('#!/bin/bash\necho pass');
  });

  it('resolves llm_rubric grader rubric from file', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline instruction',
      graders: [{ type: 'llm_rubric', rubric: 'rubric.md', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('Evaluate quality...' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].rubric).toBe('Evaluate quality...');
  });

  it('resolves solution path', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline',
      solution: 'solutions/solve.sh',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.solution).toContain('solutions/solve.sh');
  });

  it('sets empty workspace when not provided', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.workspace).toEqual([]);
  });

  it('preserves grader setup field', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{
        type: 'deterministic',
        setup: 'npm install -g typescript',
        run: 'echo ok',
        weight: 1.0,
      }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].setup).toBe('npm install -g typescript');
  });

  it('resolves conversation opener and scripted replies from files', async () => {
    const task: EvalTaskConfig = {
      type: 'conversation' as const,
      name: 'test-task',
      conversation: {
        opener: 'conversation/opener.md',
        completion: { max_turns: 4, done_phrase: 'done' },
        replies: [
          { content: 'conversation/reply-1.md' },
          { content: 'Inline fallback', when: 'goal' },
        ],
      },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockImplementation(async (candidate: any) =>
      String(candidate).includes('conversation/opener.md') ||
      String(candidate).includes('conversation/reply-1.md')
    );
    mockReadFile.mockImplementation(async (candidate: any) => {
      const fullPath = String(candidate);
      if (fullPath.includes('conversation/opener.md')) return 'Opened from file';
      if (fullPath.includes('conversation/reply-1.md')) return 'Reply from file';
      return '';
    });

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedConversationTask;
    expect(resolved.type).toBe('conversation');
    expect(resolved.conversation).toEqual({
      opener: 'Opened from file',
      completion: { max_turns: 4, done_phrase: 'done' },
      replies: [
        { content: 'Reply from file' },
        { content: 'Inline fallback', when: 'goal' },
      ],
    });
  });

  it('resolves conversation persona description from file', async () => {
    const task: EvalTaskConfig = {
      type: 'conversation' as const,
      name: 'test-task',
      conversation: {
        opener: 'Opened inline',
        completion: { max_turns: 4 },
        persona: {
          description: 'conversation/persona.md',
          facts: ['The feature is for Wix Stores'],
        },
      },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockImplementation(async (candidate: any) =>
      String(candidate).includes('conversation/persona.md')
    );
    mockReadFile.mockImplementation(async (candidate: any) => {
      const fullPath = String(candidate);
      if (fullPath.includes('conversation/persona.md')) return 'Persona loaded from file';
      return '';
    });

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedConversationTask;
    expect(resolved.conversation).toEqual({
      opener: 'Opened inline',
      completion: { max_turns: 4 },
      persona: {
        description: 'Persona loaded from file',
        facts: ['The feature is for Wix Stores'],
      },
    });
  });

  it('preserves done_when through resolution', async () => {
    const task: EvalTaskConfig = {
      type: 'conversation' as const,
      name: 'test-task',
      conversation: {
        opener: 'Opened inline',
        completion: { max_turns: 4, done_when: 'Agent delivered the brief' },
        replies: [{ content: 'ok' }],
      },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.type === 'conversation' && resolved.conversation.completion.done_when)
      .toBe('Agent delivered the brief');
  });

  it('resolveFileOrInline does not read files outside baseDir', async () => {
    // We test indirectly via resolveTask: an instruction like "../../etc/hostname"
    // should be treated as inline text, not resolved to a file.
    // Simulate the traversal target existing so the old code would read it.
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('actual-hostname-contents' as any);

    const task = {
      name: 'test',
      type: 'instruction' as const,
      instruction: '../../etc/hostname',
      graders: [{ type: 'deterministic' as const, run: 'echo ok', weight: 1.0 }],
    };
    const resolved = await resolveTask(task, defaults, '/tmp/some-project');
    // Should return the literal string, not the file contents
    expect(resolved.type === 'instruction' && resolved.instruction).toBe('../../etc/hostname');
  });
});
