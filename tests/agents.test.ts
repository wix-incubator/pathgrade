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
  function makeClaudeEnvelope(result: string, sessionId = 'sess-abc-123') {
    return JSON.stringify({ result, session_id: sessionId });
  }

  it('writes instruction via base64 and runs claude CLI with JSON output', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('claude')) {
        return { stdout: makeClaudeEnvelope('Hello from Claude'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('base64');
    expect(commands[1]).toContain('claude');
    expect(commands[1]).toContain('-p');
    expect(commands[1]).toContain('--output-format json');
    expect(commands[1]).toContain('--dangerously-skip-permissions');
    expect(commands[1]).toContain('< /dev/null');
    expect(result).toBe('Hello from Claude');
  });

  it('parses JSON envelope and extracts result text', async () => {
    const agent = new ClaudeAgent();
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: makeClaudeEnvelope('Extracted response'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toBe('Extracted response');
  });

  it('falls back to raw stdout when JSON parsing fails', async () => {
    const agent = new ClaudeAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'plain text output', stderr: 'some warning', exitCode: 0 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('plain text output');
    expect(result).toContain('some warning');
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
      if (cmd.includes('claude')) {
        return { stdout: makeClaudeEnvelope('ok'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await agent.run(instruction, '/workspace', mockRunCommand);

    const expectedB64 = Buffer.from(instruction).toString('base64');
    expect(capturedCmd).toContain(expectedB64);
  });

  it('reconstructs text from denied AskUserQuestion when result is empty', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      result: '',
      session_id: 'sess-123',
      permission_denials: [{
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_abc',
        tool_input: {
          questions: [{
            question: 'Who is the target group?',
            header: 'Target',
            options: [
              { label: 'Self-Creator', description: 'Manages their own site' },
              { label: 'Partner', description: 'Builds for clients' },
            ],
          }],
        },
      }],
    });

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: envelope, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('Target');
    expect(result).toContain('Who is the target group?');
    expect(result).toContain('Self-Creator');
    expect(result).toContain('Partner');
    // Must NOT contain raw JSON
    expect(result).not.toContain('"type":"result"');
    expect(result).not.toContain('permission_denials');
  });

  it('returns empty string when result is empty and no AskUserQuestion denial', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      result: '',
      session_id: 'sess-123',
      permission_denials: [],
    });

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: envelope, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    // Should NOT leak raw JSON — envelope was found but had no useful text
    expect(result).not.toContain('permission_denials');
    expect(result).toBe('');
  });

  it('captures session_id from first turn and uses --resume for continuation', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('claude')) {
        return {
          stdout: makeClaudeEnvelope('response text', 'test-session-123'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const turn1 = await session.start({ message: 'First turn' });
    const turn2 = await session.reply({ message: 'Second turn', continueSession: true });

    // Both turns should parse the envelope
    expect(turn1.assistantMessage).toBe('response text');
    expect(turn2.assistantMessage).toBe('response text');

    // First turn: no --resume
    expect(commands[1]).toContain('claude -p');
    expect(commands[1]).toContain('--output-format json');
    expect(commands[1]).not.toContain('--resume');

    // Second turn: uses --resume with session_id from first turn
    expect(commands[3]).toContain('--resume test-session-123');
    expect(commands[3]).toContain('--dangerously-skip-permissions');
  });
});

describe('CodexAgent', () => {
  it('seeds isolated Codex auth from OPENAI_API_KEY before exec', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-key';

    try {
      const agent = new CodexAgent();
      const commands: string[] = [];
      const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
        commands.push(cmd);
        return { stdout: 'output', stderr: '', exitCode: 0 };
      });

      await agent.run('Test instruction', '/workspace', mockRunCommand);

      expect(commands).toHaveLength(3);
      expect(commands[0]).toContain('codex login --with-api-key');
      expect(commands[1]).toContain('base64');
      expect(commands[2]).toContain('codex exec');
    } finally {
      if (originalKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalKey;
      }
    }
  });

  it('writes instruction via base64 and runs codex exec with non-git workspace support', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[1]).toContain('base64');
    expect(commands[1]).toContain('${TMPDIR:-/tmp}/.pathgrade-prompt.md');
    expect(commands[2]).toContain('codex exec');
    expect(commands[2]).toContain('--full-auto');
    expect(commands[2]).toContain('--skip-git-repo-check');
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

    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[2]).toContain('codex exec');
    expect(commands[3]).toContain('codex login --with-api-key');
    expect(commands[5]).toContain('codex exec');

    const secondPrompt = decodePromptWriteCommand(commands[4]);
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });
});
