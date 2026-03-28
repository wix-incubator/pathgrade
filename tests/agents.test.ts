import fs from 'fs-extra';
import os from 'os';
import path from 'path';
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

function extractPromptPath(cmd: string): string {
  const inputRedirectMatch = cmd.match(/< ("[^"]+"|'[^']+'|[^\s)]+)/);
  if (inputRedirectMatch) {
    return inputRedirectMatch[1].replace(/^["'](.*)["']$/, '$1');
  }

  const catMatch = cmd.match(/cat ("[^"]+"|'[^']+'|[^\s)]+)/);
  if (catMatch) {
    return catMatch[1].replace(/^["'](.*)["']$/, '$1');
  }

  throw new Error(`Could not extract prompt path from command: ${cmd}`);
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

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('gemini');
    expect(commands[0]).toContain('-y');
    expect(commands[0]).toContain('--sandbox=none');
    expect(commands[0]).toContain('.pathgrade-prompt-');

    const promptPath = extractPromptPath(commands[0]);
    expect(await fs.readFile(promptPath, 'utf8')).toBe('Test instruction');
    expect(result).toContain('output');
  });

  it('returns combined stdout and stderr', async () => {
    const agent = new GeminiAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: 'out', stderr: 'err', exitCode: 0 });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('out');
    expect(result).toContain('err');
  });

  it('handles non-zero exit code without throwing', async () => {
    const agent = new GeminiAgent();
    const mockRunCommand = vi.fn()
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
      if (cmd.includes('gemini')) capturedCmd = cmd;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await agent.run(instruction, '/workspace', mockRunCommand);

    const promptPath = extractPromptPath(capturedCmd);
    expect(await fs.readFile(promptPath, 'utf8')).toBe(instruction);
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

    expect(commands[0]).toContain('gemini');
    expect(commands[1]).toContain('gemini');

    const secondPrompt = await fs.readFile(extractPromptPath(commands[1]), 'utf8');
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });
});

describe('ClaudeAgent', () => {
  /** Build NDJSON stream-json output with a result line */
  function makeStreamJson(result: string, sessionId = 'sess-abc-123', toolUseLines: string[] = []) {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      ...toolUseLines,
      JSON.stringify({ type: 'result', result, session_id: sessionId }),
    ];
    return lines.join('\n');
  }

  /** Backwards-compat helper — same shape as old envelope */
  function makeClaudeEnvelope(result: string, sessionId = 'sess-abc-123') {
    return makeStreamJson(result, sessionId);
  }

  it('writes instruction via base64 and runs claude CLI with stream-json output', async () => {
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
    expect(commands[1]).toContain('--output-format stream-json');
    expect(commands[1]).toContain('--verbose');
    expect(commands[1]).toContain('--dangerously-skip-permissions');
    expect(commands[1]).toContain('< /dev/null');
    expect(result).toBe('Hello from Claude');
  });

  it('parses stream-json NDJSON and extracts result text', async () => {
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
    const ndjson = JSON.stringify({
      type: 'result',
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
        return { stdout: ndjson, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toContain('Target');
    expect(result).toContain('Who is the target group?');
    expect(result).toContain('Self-Creator');
    expect(result).toContain('Partner');
    // Must NOT contain raw JSON
    expect(result).not.toContain('permission_denials');
  });

  it('strips API errors from result to prevent conversation corruption', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      type: 'result',
      result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      session_id: 'sess-123',
      is_error: false,
    });

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: envelope, stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toBe('');
    expect(result).not.toContain('API Error');
  });

  it('strips result when is_error is true', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Something went wrong',
      session_id: 'sess-123',
      is_error: true,
    });

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: envelope, stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test', '/workspace', mockRunCommand);
    expect(result).toBe('');
  });

  it('extracts text from generic denied tool with text-like fields', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      type: 'result',
      result: '',
      session_id: 'sess-123',
      permission_denials: [{
        tool_name: 'SomeCustomTool',
        tool_input: {
          message: 'Please confirm the action',
          data: { nested: true },
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
    expect(result).toBe('Please confirm the action');
  });

  it('returns empty string when result is empty and no AskUserQuestion denial', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      type: 'result',
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

  it('sanitizes sessionId to prevent shell injection', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn(async (cmd: string) => {
        commands.push(cmd);
        // First call: prompt write. Second call: claude -p with injected sessionId.
        if (commands.length === 1) {
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        // Return stream-json with a malicious session_id
        return {
            stdout: JSON.stringify({
                type: 'result',
                result: 'hello',
                session_id: 'legit-id; rm -rf /'
            }),
            stderr: '',
            exitCode: 0
        };
    });

    const session = await agent.createSession('workspace', mockRunCommand);
    // First turn: establishes sessionId from response
    await session.start({ message: 'hello' });
    // Second turn: uses sessionId -- this is where injection would happen
    await session.reply({ message: 'follow up' });

    // The third command (second claude invocation) should have a sanitized sessionId
    const resumeCommand = commands[3]; // prompt write, claude, prompt write, claude
    expect(resumeCommand).not.toContain('; rm -rf /');
    expect(resumeCommand).toMatch(/--resume [a-zA-Z0-9_-]+/);
  });

  it('omits --resume when sanitized sessionId is empty string', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn(async (cmd: string) => {
      commands.push(cmd);
      if (commands.length === 1) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // Return a session_id made entirely of bad characters — sanitizes to ""
      return {
        stdout: JSON.stringify({
          type: 'result',
          result: 'hello',
          session_id: '$()'
        }),
        stderr: '',
        exitCode: 0,
      };
    });

    const session = await agent.createSession('workspace', mockRunCommand);
    await session.start({ message: 'hello' });
    await session.reply({ message: 'follow up' });

    // The second claude invocation should NOT include --resume at all
    const resumeCommand = commands[3]; // prompt write, claude, prompt write, claude
    expect(resumeCommand).not.toContain('--resume');
  });

  it('captures session_id from first turn and uses --resume for continuation', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('claude')) {
        return {
          stdout: makeStreamJson('response text', 'test-session-123'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const turn1 = await session.start({ message: 'First turn' });
    const turn2 = await session.reply({ message: 'Second turn', continueSession: true });

    // Both turns should parse the stream-json result
    expect(turn1.assistantMessage).toBe('response text');
    expect(turn2.assistantMessage).toBe('response text');

    // First turn: no --resume
    expect(commands[1]).toContain('claude -p');
    expect(commands[1]).toContain('--output-format stream-json');
    expect(commands[1]).not.toContain('--resume');

    // Second turn: uses --resume with session_id from first turn
    expect(commands[3]).toContain('--resume test-session-123');
    expect(commands[3]).toContain('--dangerously-skip-permissions');
  });
});

describe('traceOutput', () => {
  it('exposes traceOutput for Codex turns', async () => {
    const agent = new CodexAgent();
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('codex exec')) {
        return { stdout: 'tool: exec_command {"cmd":"npm test"}', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'run tests' });
    expect(result.traceOutput).toBeDefined();
    expect(result.traceOutput).toContain('tool');
    expect(result.traceOutput).toBe(result.rawOutput);
  });

  it('exposes traceOutput for Gemini turns', async () => {
    const agent = new GeminiAgent();
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('gemini')) {
        return { stdout: 'tool: read_file {"path":"src/app.ts"}', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'read file' });
    expect(result.traceOutput).toBeDefined();
    expect(result.traceOutput).toContain('tool');
    expect(result.traceOutput).toBe(result.rawOutput);
  });

  it('sets traceOutput to full NDJSON stream for Claude (contains tool_use blocks)', async () => {
    const agent = new ClaudeAgent();
    const toolUseLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'app.ts' } }] },
    });
    const ndjson = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      toolUseLine,
      JSON.stringify({ type: 'result', result: 'hello from claude', session_id: 'sess-1' }),
    ].join('\n');

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: ndjson, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'hello' });
    expect(result.traceOutput).toBeDefined();
    // traceOutput should contain full NDJSON stream (for tool extraction), not just result text
    expect(result.traceOutput).toContain('tool_use');
    expect(result.traceOutput).toContain('Read');
    // rawOutput should be just the result text
    expect(result.rawOutput).toBe('hello from claude');
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

      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('codex login --with-api-key');
      expect(commands[1]).toContain('codex exec');
      expect(commands[1]).toContain(' < ');
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

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[1]).toContain('codex exec');
    expect(commands[1]).toContain('--full-auto');
    expect(commands[1]).toContain('--skip-git-repo-check');
    expect(commands[1]).toContain(' < ');

    const promptPath = extractPromptPath(commands[1]);
    expect(await fs.readFile(promptPath, 'utf8')).toBe('Test instruction');
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
    expect(commands[1]).toContain('codex exec');
    expect(commands[2]).toContain('codex login --with-api-key');
    expect(commands[3]).toContain('codex exec');

    const secondPrompt = await fs.readFile(extractPromptPath(commands[3]), 'utf8');
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });

  it('guards API-key login seeding and Codex exec env for host-auth mode', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands[0]).toContain('PATHGRADE_CODEX_USE_HOST_AUTH');
    expect(commands[0]).toContain('codex login --with-api-key');
    expect(commands[1]).toContain('env -u OPENAI_API_KEY -u OPENAI_BASE_URL codex exec');
  });

  it('keeps the full Codex trace in traceOutput but only the final answer in assistantMessage', async () => {
    const agent = new CodexAgent();
    const mockRunCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: 'Fixed the bug.',
        stderr: 'OpenAI Codex v0.117.0-alpha.10\nexec\n/bin/zsh -lc "sed -n \'1,200p\' app.js"',
        exitCode: 0,
      });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'Fix app.js' });

    expect(result.assistantMessage).toBe('Fixed the bug.');
    expect(result.traceOutput).toContain('OpenAI Codex');
    expect(result.traceOutput).toContain('sed -n');
    expect(result.rawOutput).toContain('Fixed the bug.');
  });

  it('writes transcript prompts to a temp file instead of shell-encoding them', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const largeMessage = 'x'.repeat(50_000);
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    await agent.run(largeMessage, path.join(os.tmpdir(), 'pathgrade-agent-test'), mockRunCommand);

    expect(commands).toHaveLength(2);
    expect(commands[1]).not.toContain('base64');
    const promptPath = extractPromptPath(commands[1]);
    expect(await fs.readFile(promptPath, 'utf8')).toBe(largeMessage);
  });
});
