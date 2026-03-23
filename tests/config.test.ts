import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs-extra before importing
vi.mock('fs-extra', () => ({
  pathExists: vi.fn(),
  readFile: vi.fn(),
}));

import * as fs from 'fs-extra';
import { loadEvalConfig, resolveTask } from '../src/core/config';
import { EvalTaskConfig, EvalDefaults } from '../src/core/config.types';

const mockPathExists = vi.mocked(fs.pathExists);
const mockReadFile = vi.mocked(fs.readFile);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadEvalConfig', () => {
  it('throws when eval.yaml is missing', async () => {
    mockPathExists.mockResolvedValue(false as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('No eval.yaml found');
  });

  it('throws when YAML is not an object', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('just a string' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('must be a YAML object');
  });

  it('throws when tasks array is missing', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('version: "1"\n' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one task');
  });

  it('throws when tasks array is empty', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('version: "1"\ntasks: []\n' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one task');
  });

  it('throws when task is missing name', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - instruction: "do something"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('missing a "name"');
  });

  it('throws when task is missing instruction', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('missing an "instruction"');
  });

  it('accepts conversation tasks without instruction', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    conversation:
      opener: "Start here"
      completion:
        max_turns: 3
      replies:
        - content: "First reply"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].instruction).toBeUndefined();
    expect(config.tasks[0].conversation).toEqual({
      opener: 'Start here',
      completion: { max_turns: 3 },
      replies: [{ content: 'First reply' }],
    });
  });

  it('accepts conversation tasks with persona fallback and no scripted replies', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    conversation:
      opener: "Start here"
      completion:
        max_turns: 3
      persona:
        description: "You are a concise product manager."
        facts:
          - "The feature is for Wix Stores"
          - "You do not know the implementation details"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].instruction).toBeUndefined();
    expect(config.tasks[0].conversation).toEqual({
      opener: 'Start here',
      completion: { max_turns: 3 },
      persona: {
        description: 'You are a concise product manager.',
        facts: [
          'The feature is for Wix Stores',
          'You do not know the implementation details',
        ],
      },
    });
  });

  it('rejects conversation tasks with neither scripted replies nor persona', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    conversation:
      opener: "Start here"
      completion:
        max_turns: 3
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow(
      'must include at least one of "replies" or "persona"'
    );
  });

  it('throws when task has no graders', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: "do something"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one grader');
  });

  it('throws on workspace mapping without src/dest', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: "do something"
    workspace:
      - { foo: bar }
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('without src/dest');
  });

  it('parses valid config correctly', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
skill: ./SKILL.md
defaults:
  agent: claude
  trials: 10
tasks:
  - name: test-task
    instruction: "install the app"
    graders:
      - type: deterministic
        run: "echo ok"
        weight: 0.7
      - type: llm_rubric
        rubric: "check quality"
        weight: 0.3
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.version).toBe('1');
    expect(config.skill).toBe('./SKILL.md');
    expect(config.defaults.agent).toBe('claude');
    expect(config.defaults.trials).toBe(10);
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].name).toBe('test-task');
    expect(config.tasks[0].graders).toHaveLength(2);
    expect(config.tasks[0].graders[0].weight).toBe(0.7);
    expect(config.tasks[0].graders[1].type).toBe('llm_rubric');
  });

  it('applies default values when defaults not specified', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.environment).toEqual({ cpus: 2, memory_mb: 2048 });
    expect(config.defaults).not.toHaveProperty('provider');
    expect(config.defaults).not.toHaveProperty('docker');
  });

  it('rejects deprecated defaults.provider', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  provider: local
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('defaults.provider');
  });

  it('rejects deprecated defaults.docker', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
defaults:
  docker:
    base: node:20-slim
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('defaults.docker');
  });

  it('rejects deprecated task-level provider and docker fields', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    provider: docker
    docker:
      base: node:20-slim
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    await expect(loadEvalConfig('/test')).rejects.toThrow('Task "test-task" uses deprecated');
  });

  it('handles workspace string shorthand', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    workspace:
      - fixtures/app.js
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].workspace).toEqual([
      { src: 'fixtures/app.js', dest: 'app.js' },
    ]);
  });

  it('handles workspace objects with chmod', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    workspace:
      - src: scripts/run.sh
        dest: /workspace/run.sh
        chmod: "+x"
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].workspace).toEqual([
      { src: 'scripts/run.sh', dest: '/workspace/run.sh', chmod: '+x' },
    ]);
  });

  it('defaults grader weight to 1.0', async () => {
    mockPathExists.mockResolvedValue(true as any);
    const yaml = `version: "1"
tasks:
  - name: test-task
    instruction: do it
    graders:
      - type: deterministic
        run: "echo ok"
`;
    mockReadFile.mockResolvedValue(yaml as any);

    const config = await loadEvalConfig('/test');
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
      name: 'test-task',
      instruction: 'do it',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    // The instruction is inline (multi-line would be caught, single line tries file path)
    mockPathExists.mockResolvedValue(false as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.agent).toBe('gemini');
    expect(resolved.trials).toBe(5);
    expect(resolved.timeout).toBe(300);
    expect(resolved.environment).toEqual({ cpus: 2, memory_mb: 2048 });
  });

  it('task overrides take precedence over defaults', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'do it now',
      agent: 'claude',
      trials: 10,
      timeout: 600,
      environment: { memory_mb: 4096 },
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(false as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.agent).toBe('claude');
    expect(resolved.trials).toBe(10);
    expect(resolved.timeout).toBe(600);
    expect(resolved.environment).toEqual({ cpus: 2, memory_mb: 4096 });
  });

  it('resolves instruction from file when it exists', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'instruction.md',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('File content here' as any);

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.instruction).toBe('File content here');
  });

  it('keeps inline multi-line instruction as-is', async () => {
    const task: EvalTaskConfig = {
      name: 'test-task',
      instruction: 'line 1\nline 2\nline 3',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.instruction).toBe('line 1\nline 2\nline 3');
  });

  it('resolves deterministic grader run from file', async () => {
    const task: EvalTaskConfig = {
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
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.workspace).toEqual([]);
  });

  it('preserves grader setup field', async () => {
    const task: EvalTaskConfig = {
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

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.instruction).toBeUndefined();
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

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.conversation).toEqual({
      opener: 'Opened inline',
      completion: { max_turns: 4 },
      persona: {
        description: 'Persona loaded from file',
        facts: ['The feature is for Wix Stores'],
      },
    });
  });
});
