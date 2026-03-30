import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateConfig, resolveTask } from '../src/core/config';
import { EvalTaskConfig, EvalDefaults, ConversationTaskConfig, ResolvedInstructionTask, ResolvedConversationTask, InstructionTaskConfig } from '../src/core/config.types';
import { deterministicGrader } from '../src/core/grader-factories';
import { mockMcpServer } from '../src/core/mcp-mock';
import * as os from 'os';
import * as path from 'path';
import { promises as nativeFs } from 'fs';

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

const stubExecute = async () => ({ score: 1 });
const stubGrader = deterministicGrader({ execute: stubExecute });

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
      tasks: [{ type: 'instruction', instruction: 'do something', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
    })).toThrow('missing a "name"');
  });

  it('rejects task without type field', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', instruction: 'do it', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
    })).toThrow('missing a "type"');
  });

  it('rejects instruction task without instruction field', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'instruction', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
    })).toThrow('missing an "instruction"');
  });

  it('rejects conversation task without conversation block', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'conversation', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
    })).toThrow('missing a "conversation"');
  });

  it('rejects invalid task type', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{ name: 'test-task', type: 'unknown', instruction: 'do it', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
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
          reactions: [{ when: '.*', reply: 'First reply' }],
        },
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    const task0 = config.tasks[0] as ConversationTaskConfig;
    expect(task0.conversation).toEqual({
      opener: 'Start here',
      completion: { max_turns: 3 },
      reactions: [{ when: '.*', reply: 'First reply' }],
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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

  it('accepts conversation completion.output_path', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: {
          opener: 'Start here',
          completion: { max_turns: 3, output_path: 'artifacts/output.md' },
          reactions: [{ when: '.*', reply: 'First reply' }],
        },
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });

    const task0 = config.tasks[0] as ConversationTaskConfig;
    expect(task0.conversation.completion).toEqual({
      max_turns: 3,
      output_path: 'artifacts/output.md',
    });
  });

  it('rejects legacy conversation completion.signal', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: {
          opener: 'Start here',
          completion: { max_turns: 3, signal: 'artifacts/output.md' },
          reactions: [{ when: '.*', reply: 'First reply' }],
        },
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    })).toThrow('completion.signal');
  });

  it('rejects conversation tasks with neither scripted replies nor persona', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'conversation',
        conversation: { opener: 'Start here', completion: { max_turns: 3 } },
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    })).toThrow('must include at least one of "reactions" or "persona"');
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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
          { type: 'deterministic', execute: async () => ({ score: 1 }), weight: 0.7 },
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    expect(config.defaults.agent).toBe('claude');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.environment).toEqual({ cpus: 2, memory_mb: 2048 });
  });

  it('rejects deprecated defaults.provider', () => {
    expect(() => validateConfig({
      version: '1',
      defaults: { provider: 'local' },
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
    })).toThrow('defaults.provider');
  });

  it('rejects deprecated defaults.docker', () => {
    expect(() => validateConfig({
      version: '1',
      defaults: { docker: { base: 'node:20-slim' } },
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { src: 'scripts/run.sh', dest: '/workspace/run.sh', chmod: '+x' },
    ]);
  });

  it('handles workspace directory mapping', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: [{ dir: 'fixtures' }],
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { dir: 'fixtures' },
    ]);
  });

  it('handles workspace directory mapping with chmod', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: [{ dir: 'scripts', chmod: '+x' }],
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { dir: 'scripts', chmod: '+x' },
    ]);
  });

  it('handles mixed workspace entries (dir + file + string)', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: [
          { dir: 'fixtures' },
          { src: 'bin/tool', dest: '/usr/local/bin/tool', chmod: '+x' },
          'extra/readme.txt',
        ],
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    });
    expect(config.tasks[0].workspace).toEqual([
      { dir: 'fixtures' },
      { src: 'bin/tool', dest: '/usr/local/bin/tool', chmod: '+x' },
      { src: 'extra/readme.txt', dest: 'readme.txt' },
    ]);
  });

  it('throws on workspace directory mapping with empty dir', () => {
    expect(() => validateConfig({
      version: '1',
      tasks: [{
        name: 'test-task',
        type: 'instruction',
        instruction: 'do it',
        workspace: [{ dir: '' }],
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
      }],
    })).toThrow('without');
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
          reactions: [{ when: '.*', reply: 'ok' }],
        },
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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
      tasks: [{ name: 'test-task', type: 'instruction', instruction: 'do it', graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }] }],
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
        graders: [{ type: 'deterministic', execute: async () => ({ score: 1 }) }],
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
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      }],
    });
    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });
});

describe('resolveTask', () => {
  const defaults: EvalDefaults = {
    agent: 'claude',
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
      graders: [stubGrader],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.agent).toBe('claude');
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
      graders: [stubGrader],
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
      graders: [stubGrader],
    };

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedInstructionTask;
    expect(resolved.instruction).toBe('line 1\nline 2\nline 3');
  });

  it('resolves instruction from file when it exists', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'instruction.md',
      graders: [stubGrader],
    };

    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('File content here' as any);

    const resolved = await resolveTask(task, defaults, '/base') as ResolvedInstructionTask;
    expect(resolved.instruction).toBe('File content here');
  });

  it('preserves deterministic grader execute function through resolution', async () => {
    const execute = async () => ({ score: 1, details: 'ok' });
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline instruction',
      graders: [deterministicGrader({ execute })],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.graders[0].execute).toBe(execute);
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
      graders: [stubGrader],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.solution).toContain('solutions/solve.sh');
  });

  it('sets empty workspace when not provided', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'test-task',
      instruction: 'multi\nline',
      graders: [stubGrader],
    };

    const resolved = await resolveTask(task, defaults, '/base');
    expect(resolved.workspace).toEqual([]);
  });

  it('resolves conversation opener and scripted replies from files', async () => {
    const task: EvalTaskConfig = {
      type: 'conversation' as const,
      name: 'test-task',
      conversation: {
        opener: 'conversation/opener.md',
        completion: { max_turns: 4, done_phrase: 'done' },
        reactions: [
          { when: '.*', reply: 'conversation/reply-1.md' },
          { when: 'goal', reply: 'Inline fallback' },
        ],
      },
      graders: [stubGrader],
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
      reactions: [
        { when: '.*', reply: 'Reply from file' },
        { when: 'goal', reply: 'Inline fallback' },
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
      graders: [stubGrader],
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
        reactions: [{ when: '.*', reply: 'ok' }],
      },
      graders: [stubGrader],
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
      graders: [stubGrader],
    };
    const resolved = await resolveTask(task, defaults, '/tmp/some-project');
    // Should return the literal string, not the file contents
    expect(resolved.type === 'instruction' && resolved.instruction).toBe('../../etc/hostname');
  });

  it('expands workspace directory into individual file mappings', async () => {
    // Create a temp fixtures directory with files
    const baseDir = path.join(os.tmpdir(), `pathgrade-resolve-dir-${Date.now()}`);
    const fixturesDir = path.join(baseDir, 'fixtures');
    await nativeFs.mkdir(fixturesDir, { recursive: true });
    await nativeFs.writeFile(path.join(fixturesDir, 'app.js'), 'console.log("app")');
    await nativeFs.writeFile(path.join(fixturesDir, 'helper.js'), 'console.log("helper")');

    try {
      const task: EvalTaskConfig = {
        type: 'instruction' as const,
        name: 'dir-test',
        instruction: 'do it',
        workspace: [{ dir: 'fixtures' }],
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      };

      const resolved = await resolveTask(task, defaults, baseDir);
      const ws = resolved.workspace.sort((a, b) => a.dest.localeCompare(b.dest));
      expect(ws).toEqual([
        { src: 'fixtures/app.js', dest: 'app.js' },
        { src: 'fixtures/helper.js', dest: 'helper.js' },
      ]);
    } finally {
      await nativeFs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('expands nested directory structure preserving paths', async () => {
    const baseDir = path.join(os.tmpdir(), `pathgrade-resolve-nested-${Date.now()}`);
    await nativeFs.mkdir(path.join(baseDir, 'fixtures', 'src', 'app'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', 'src', 'app', 'main.ts'), 'main');
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', 'config.json'), '{}');

    try {
      const task: EvalTaskConfig = {
        type: 'instruction' as const,
        name: 'nested-test',
        instruction: 'do it',
        workspace: [{ dir: 'fixtures' }],
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      };

      const resolved = await resolveTask(task, defaults, baseDir);
      const ws = resolved.workspace.sort((a, b) => a.dest.localeCompare(b.dest));
      expect(ws).toEqual([
        { src: 'fixtures/config.json', dest: 'config.json' },
        { src: 'fixtures/src/app/main.ts', dest: 'src/app/main.ts' },
      ]);
    } finally {
      await nativeFs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('applies chmod from directory mapping to all expanded files', async () => {
    const baseDir = path.join(os.tmpdir(), `pathgrade-resolve-chmod-${Date.now()}`);
    await nativeFs.mkdir(path.join(baseDir, 'scripts'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'scripts', 'run.sh'), '#!/bin/bash');

    try {
      const task: EvalTaskConfig = {
        type: 'instruction' as const,
        name: 'chmod-test',
        instruction: 'do it',
        workspace: [{ dir: 'scripts', chmod: '+x' }],
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      };

      const resolved = await resolveTask(task, defaults, baseDir);
      expect(resolved.workspace).toEqual([
        { src: 'scripts/run.sh', dest: 'run.sh', chmod: '+x' },
      ]);
    } finally {
      await nativeFs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('skips dotfiles when expanding directories', async () => {
    const baseDir = path.join(os.tmpdir(), `pathgrade-resolve-dotfiles-${Date.now()}`);
    await nativeFs.mkdir(path.join(baseDir, 'fixtures'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', 'app.js'), 'app');
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', '.DS_Store'), 'junk');
    await nativeFs.mkdir(path.join(baseDir, 'fixtures', '.hidden'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', '.hidden', 'secret'), 'x');

    try {
      const task: EvalTaskConfig = {
        type: 'instruction' as const,
        name: 'dotfile-test',
        instruction: 'do it',
        workspace: [{ dir: 'fixtures' }],
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      };

      const resolved = await resolveTask(task, defaults, baseDir);
      expect(resolved.workspace).toEqual([
        { src: 'fixtures/app.js', dest: 'app.js' },
      ]);
    } finally {
      await nativeFs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it('rejects task with both mcp_config and mcp_mock', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const mock = mockMcpServer({
      name: 'weather',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'both-mcp',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_config: './servers.json',
      mcp_mock: mock,
    };

    await expect(resolveTask(task, defaults, '/base/dir')).rejects.toThrow(/mutually exclusive/i);
  });

  it('rejects mcp_mock inherited from defaults when task has mcp_config', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const mock = mockMcpServer({
      name: 'weather',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'conflict',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_config: './servers.json',
    };

    const defaultsWithMock = { ...defaults, mcp_mock: mock };
    await expect(resolveTask(task, defaultsWithMock, '/base/dir')).rejects.toThrow(/mutually exclusive/i);
  });

  it('passes mcp_mock through resolveTask', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const mock = mockMcpServer({
      name: 'weather',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'mock-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_mock: mock,
    };

    const resolved = await resolveTask(task, defaults, '/base/dir');
    expect((resolved as any).mcp_mock).toBe(mock);
  });

  it('inherits mcp_mock from defaults', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const mock = mockMcpServer({
      name: 'weather',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'inherit-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
    };

    const defaultsWithMock = { ...defaults, mcp_mock: mock };
    const resolved = await resolveTask(task, defaultsWithMock, '/base/dir');
    expect((resolved as any).mcp_mock).toBe(mock);
  });

  it('task mcp_mock replaces defaults mcp_mock (no merging)', async () => {
    mockPathExists.mockResolvedValue(false as any);
    const defaultMock = mockMcpServer({
      name: 'default-server',
      tools: [{ name: 'default_tool', response: 'default' }],
    });
    const taskMock = mockMcpServer({
      name: 'task-server',
      tools: [{ name: 'task_tool', response: 'task' }],
    });

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'override-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_mock: taskMock,
    };

    const defaultsWithMock = { ...defaults, mcp_mock: defaultMock };
    const resolved = await resolveTask(task, defaultsWithMock, '/base/dir');
    expect((resolved as any).mcp_mock).toBe(taskMock);
  });

  it('returns empty workspace for nonexistent directory', async () => {
    const task: EvalTaskConfig = {
      type: 'instruction' as const,
      name: 'missing-dir-test',
      instruction: 'do it',
      workspace: [{ dir: 'nonexistent' }],
      graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
    };

    const resolved = await resolveTask(task, defaults, '/tmp');
    expect(resolved.workspace).toEqual([]);
  });

  it('resolves mcp_config path relative to baseDir', async () => {
    mockPathExists.mockResolvedValue(false as any);

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'mcp-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_config: './mcp-servers.json',
    };

    const resolved = await resolveTask(task, defaults, '/base/dir');
    expect(resolved.mcp_config).toBe(path.resolve('/base/dir', './mcp-servers.json'));
  });

  it('resolves mcp_config from defaults when task omits it', async () => {
    mockPathExists.mockResolvedValue(false as any);

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'mcp-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
    };

    const defaultsWithMcp = { ...defaults, mcp_config: './default-mcp.json' };
    const resolved = await resolveTask(task, defaultsWithMcp, '/base/dir');
    expect(resolved.mcp_config).toBe(path.resolve('/base/dir', './default-mcp.json'));
  });

  it('task mcp_config overrides defaults mcp_config', async () => {
    mockPathExists.mockResolvedValue(false as any);

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'mcp-test',
      instruction: 'inline instruction',
      graders: [stubGrader],
      mcp_config: './task-mcp.json',
    };

    const defaultsWithMcp = { ...defaults, mcp_config: './default-mcp.json' };
    const resolved = await resolveTask(task, defaultsWithMcp, '/base/dir');
    expect(resolved.mcp_config).toBe(path.resolve('/base/dir', './task-mcp.json'));
  });

  it('resolved mcp_config is undefined when not specified', async () => {
    mockPathExists.mockResolvedValue(false as any);

    const task: InstructionTaskConfig = {
      type: 'instruction',
      name: 'test',
      instruction: 'inline instruction',
      graders: [stubGrader],
    };

    const resolved = await resolveTask(task, defaults, '/base/dir');
    expect(resolved.mcp_config).toBeUndefined();
  });

  it('mixes directory and file mappings in workspace', async () => {
    const baseDir = path.join(os.tmpdir(), `pathgrade-resolve-mix-${Date.now()}`);
    await nativeFs.mkdir(path.join(baseDir, 'fixtures'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'fixtures', 'data.json'), '{}');
    await nativeFs.mkdir(path.join(baseDir, 'bin'), { recursive: true });
    await nativeFs.writeFile(path.join(baseDir, 'bin', 'tool'), '#!/bin/bash');

    try {
      const task: EvalTaskConfig = {
        type: 'instruction' as const,
        name: 'mix-test',
        instruction: 'do it',
        workspace: [
          { dir: 'fixtures' },
          { src: 'bin/tool', dest: '/usr/local/bin/tool', chmod: '+x' },
        ],
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      };

      const resolved = await resolveTask(task, defaults, baseDir);
      expect(resolved.workspace).toEqual([
        { src: 'fixtures/data.json', dest: 'data.json' },
        { src: 'bin/tool', dest: '/usr/local/bin/tool', chmod: '+x' },
      ]);
    } finally {
      await nativeFs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe('tool_usage grader config', () => {
  it('accepts tool_usage graders with expectations', () => {
    const config = validateConfig({
      version: '1',
      tasks: [{
        name: 'tool-task',
        type: 'instruction',
        instruction: 'fix the bug',
        graders: [{
          type: 'tool_usage',
          weight: 1,
          expectations: [{ action: 'run_shell', min: 1 }],
        }],
      }],
    });

    expect(config.tasks[0].graders[0]).toEqual(
      expect.objectContaining({ type: 'tool_usage' })
    );
    expect(config.tasks[0].graders[0].expectations).toHaveLength(1);
    expect(config.tasks[0].graders[0].expectations![0].action).toBe('run_shell');
  });

  it('resolves tool_usage grader with expectations', async () => {
    const task: InstructionTaskConfig = {
      name: 'tool-task',
      type: 'instruction',
      instruction: 'fix it',
      graders: [{
        type: 'tool_usage',
        weight: 0.5,
        expectations: [
          { action: 'read_file', min: 1 },
          { action: 'edit_file', min: 1 },
        ],
      }],
    };
    const defaults: EvalDefaults = {
      agent: 'claude',
      trials: 1,
      timeout: 60,
      threshold: 0.8,
      environment: { cpus: 1, memory_mb: 512 },
    };
    const resolved = await resolveTask(task, defaults, '/tmp/test');
    expect(resolved.graders[0].type).toBe('tool_usage');
    expect(resolved.graders[0].expectations).toHaveLength(2);
  });
});
