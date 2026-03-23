import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiAgent } from '../src/agents/gemini';
import { ClaudeAgent } from '../src/agents/claude';
import { CodexAgent } from '../src/agents/codex';
import { CommandResult } from '../src/types';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function decodePromptWriteCommand(cmd: string): string {
  const match = cmd.match(/echo '([^']+)' \| base64 -d/);
  if (!match) {
    throw new Error(`Could not extract base64 payload from command: ${cmd}`);
  }
  return Buffer.from(match[1], 'base64').toString('utf8');
}

describe('GeminiAgent', () => {
  it('writes instruction via base64 and runs gemini CLI', async () => {
    const agent = new GeminiAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('base64');
    expect(commands[0]).toContain('${TMPDIR:-/tmp}/.pathgrade-prompt.md');
    expect(commands[1]).toContain('gemini');
    expect(commands[1]).toContain('-y');
    expect(commands[1]).toContain('--sandbox=none');
    expect(result).toContain('output');
  });

  it('returns combined stdout and stderr', async () => {
    const agent = new GeminiAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'out', stderr: 'err', exitCode: 0 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('out');
    expect(result).toContain('err');
  });

  it('handles non-zero exit code without throwing', async () => {
    const agent = new GeminiAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'partial', stderr: 'error', exitCode: 1 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('partial');
    expect(result).toContain('error');
  });

  it('correctly base64 encodes the instruction', async () => {
    const agent = new GeminiAgent();
    const instruction = 'Hello World!';
    let capturedCmd = '';
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('base64')) capturedCmd = cmd;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await agent.run(instruction, '/workspace', mockRunCommand);

    const expectedB64 = Buffer.from(instruction).toString('base64');
    expect(capturedCmd).toContain(expectedB64);
  });

  it('falls back to transcript accumulation for session replies', async () => {
    const agent = new GeminiAgent();
    const commands: string[] = [];
    let cliCallCount = 0;
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('gemini')) {
        cliCallCount++;
        return {
          stdout: cliCallCount === 1 ? 'assistant one' : 'assistant two',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    await session.start({ message: 'First user message' });
    await session.reply({ message: 'Second user message', continueSession: true });

    expect(commands[1]).toContain('gemini');
    expect(commands[3]).toContain('gemini');

    const secondPrompt = decodePromptWriteCommand(commands[2]);
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });
});

describe('ClaudeAgent', () => {
  it('writes instruction via base64 and runs claude CLI', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('base64');
    expect(commands[0]).toContain('${TMPDIR:-/tmp}/.pathgrade-prompt.md');
    expect(commands[1]).toContain('claude');
    expect(commands[1]).toContain('-p');
    expect(commands[1]).toContain('--dangerously-skip-permissions');
    expect(result).toContain('output');
  });

  it('returns combined stdout and stderr', async () => {
    const agent = new ClaudeAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'claude-out', stderr: 'claude-err', exitCode: 0 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('claude-out');
    expect(result).toContain('claude-err');
  });

  it('handles non-zero exit code without throwing', async () => {
    const agent = new ClaudeAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'failed', exitCode: 1 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('failed');
  });

  it('correctly base64 encodes the instruction', async () => {
    const agent = new ClaudeAgent();
    const instruction = 'Complex instruction with "quotes" and special chars!';
    let capturedCmd = '';
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('base64')) capturedCmd = cmd;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await agent.run(instruction, '/workspace', mockRunCommand);

    const expectedB64 = Buffer.from(instruction).toString('base64');
    expect(capturedCmd).toContain(expectedB64);
  });

  it('uses native continuation when replying in a session', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    await session.start({ message: 'First turn' });
    await session.reply({ message: 'Second turn', continueSession: true });

    expect(commands).toHaveLength(4);
    expect(commands[1]).toContain('claude -p --dangerously-skip-permissions');
    expect(commands[3]).toContain('claude -p -c --dangerously-skip-permissions');
  });
});

describe('CodexAgent', () => {
  it('writes instruction via base64 and runs codex exec with non-git workspace support', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('base64');
    expect(commands[0]).toContain('${TMPDIR:-/tmp}/.pathgrade-prompt.md');
    expect(commands[1]).toContain('codex exec');
    expect(commands[1]).toContain('--full-auto');
    expect(commands[1]).toContain('--skip-git-repo-check');
    expect(result).toContain('output');
  });

  it('falls back to transcript accumulation for session replies', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    let cliCallCount = 0;
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('codex exec')) {
        cliCallCount++;
        return {
          stdout: cliCallCount === 1 ? 'assistant one' : 'assistant two',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    await session.start({ message: 'First user message' });
    await session.reply({ message: 'Second user message', continueSession: true });

    expect(commands[1]).toContain('codex exec');
    expect(commands[3]).toContain('codex exec');

    const secondPrompt = decodePromptWriteCommand(commands[2]);
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });
});
