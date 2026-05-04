import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CursorAgent } from '../src/agents/cursor.js';
import { CommandResult } from '../src/types.js';

function isCursorPromptCommand(cmd: string): boolean {
  return /(?:^|[/"\s])cursor-agent"?\s+-p\b/.test(cmd);
}

function makeCursorResultNdjson(opts: {
  sessionId?: string;
  result?: string;
  isError?: boolean;
  toolCallLines?: string[];
} = {}): string {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: opts.sessionId ?? 'sess-1' }),
    ...(opts.toolCallLines ?? []),
    JSON.stringify({
      type: 'result',
      is_error: opts.isError ?? false,
      session_id: opts.sessionId ?? 'sess-1',
      result: opts.result ?? 'ok',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ];
  return lines.join('\n');
}

describe('CursorAgent runTurn', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-cursor-ws-'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await fs.remove(workspace);
    vi.restoreAllMocks();
  });

  it('builds argv with -p, --output-format stream-json, --trust, --force, --workspace', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'Do the thing' });

    const cmd = commands.find(isCursorPromptCommand);
    expect(cmd).toBeDefined();
    expect(cmd).toContain(' -p ');
    expect(cmd).toContain('--output-format stream-json');
    expect(cmd).toContain('--trust');
    expect(cmd).toContain('--force');
    expect(cmd).toContain(`--workspace "${workspace}"`);
  });

  it('omits --model when no model option provided', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'hi' });

    const cmd = commands.find(isCursorPromptCommand);
    expect(cmd).not.toContain('--model');
  });

  it('passes --model <m> when model option is set', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand, { model: 'gpt-5' });
    await session.start({ message: 'hi' });

    const cmd = commands.find(isCursorPromptCommand);
    expect(cmd).toContain('--model gpt-5');
  });

  it('omits --approve-mcps when mcpConfigPath is not set', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'hi' });

    const cmd = commands.find(isCursorPromptCommand);
    expect(cmd).not.toContain('--approve-mcps');
  });

  it('emits --approve-mcps and writes .cursor/mcp.json when mcpConfigPath is set', async () => {
    const agent = new CursorAgent();
    const mcpConfigPath = '.pathgrade-mcp.json';
    const mcpServers = { demo: { command: 'node', args: ['server.js'] } };
    await fs.writeJson(path.join(workspace, mcpConfigPath), { mcpServers }, { spaces: 2 });

    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand, { mcpConfigPath });
    await session.start({ message: 'hi' });

    const cmd = commands.find(isCursorPromptCommand);
    expect(cmd).toContain('--approve-mcps');

    const cursorMcp = await fs.readJson(path.join(workspace, '.cursor', 'mcp.json'));
    expect(cursorMcp).toEqual({ mcpServers });
  });

  it('writes prompt via tempfile and splices it into argv with "$(cat …)"', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: makeCursorResultNdjson(), stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'Secret "quoted" instruction!' });

    expect(commands.length).toBeGreaterThanOrEqual(2);
    // First command writes prompt as base64
    expect(commands[0]).toContain('base64');
    const b64 = Buffer.from('Secret "quoted" instruction!').toString('base64');
    expect(commands[0]).toContain(b64);
    // Second command invokes cursor-agent and references the prompt via $(cat …)
    const cmd = commands.find(isCursorPromptCommand)!;
    expect(cmd).toMatch(/\$\(cat [^)]+\)/);
  });

  it('successful turn populates rawOutput with result text and toolEvents from stream-json', async () => {
    const agent = new CursorAgent();
    const toolCall = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      readToolCall: { args: { path: 'app.ts' } },
    });
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (isCursorPromptCommand(cmd)) {
        return {
          stdout: makeCursorResultNdjson({
            sessionId: 'sess-xyz',
            result: 'All done.',
            toolCallLines: [toolCall],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    const result = await session.start({ message: 'read app.ts' });

    expect(result.rawOutput).toBe('All done.');
    expect(result.exitCode).toBe(0);
    expect(result.toolEvents).toHaveLength(1);
    expect(result.toolEvents[0]).toMatchObject({
      provider: 'cursor',
      action: 'read_file',
      providerToolName: 'readToolCall',
    });
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('degrades gracefully on non-JSON output (workspace-trust block)', async () => {
    const agent = new CursorAgent();
    const trustBlock = 'Workspace Trust Required\n\nPlease run `cursor-agent login` first.';
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (isCursorPromptCommand(cmd)) {
        return { stdout: trustBlock, stderr: '', exitCode: 2 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    const result = await session.start({ message: 'hi' });

    expect(result.exitCode).toBe(2);
    expect(result.toolEvents).toEqual([]);
    expect(result.rawOutput).toContain('Workspace Trust Required');
    expect(result.assistantMessage).toBe('');
  });

  it('propagates missing binary errors (ENOENT from runCommand)', async () => {
    const agent = new CursorAgent();
    const err = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' });
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (isCursorPromptCommand(cmd)) {
        throw err;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await expect(session.start({ message: 'hi' })).rejects.toThrow(/ENOENT/);
  });

  it('first turn omits --resume', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        return { stdout: makeCursorResultNdjson({ sessionId: 'abc123' }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'hi' });

    const cmd = commands.find(isCursorPromptCommand)!;
    expect(cmd).not.toContain('--resume');
  });

  it('captures session_id from turn 1 result event and passes --resume on turn 2', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        return {
          stdout: makeCursorResultNdjson({ sessionId: 'abc123', result: 'turn output' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    const turn1 = await session.start({ message: 'first' });
    const turn2 = await session.reply({ message: 'second' });

    expect(turn1.rawOutput).toBe('turn output');
    expect(turn2.rawOutput).toBe('turn output');

    const cursorCmds = commands.filter(isCursorPromptCommand);
    expect(cursorCmds).toHaveLength(2);
    expect(cursorCmds[0]).not.toContain('--resume');
    expect(cursorCmds[1]).toContain('--resume abc123');
    // Ensure single-turn flags are still present on the resume call
    expect(cursorCmds[1]).toContain('-p ');
    expect(cursorCmds[1]).toContain('--output-format stream-json');
    expect(cursorCmds[1]).toContain('--trust');
    expect(cursorCmds[1]).toContain('--force');
    expect(cursorCmds[1]).toContain(`--workspace "${workspace}"`);
  });

  it('prefers the session_id from the result event over the init event', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stale-init' }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        session_id: 'authoritative-result',
        result: 'ok',
      }),
    ].join('\n');

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        return { stdout: stream, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'first' });
    await session.reply({ message: 'second' });

    const cursorCmds = commands.filter(isCursorPromptCommand);
    expect(cursorCmds[1]).toContain('--resume authoritative-result');
    expect(cursorCmds[1]).not.toContain('stale-init');
  });

  it('does not pass --resume on turn 2 when turn 1 failed to produce a result event', async () => {
    // Non-JSON degraded path: no session id captured — turn 2 re-issues
    // without --resume rather than throwing, so the user sees a fresh
    // cursor-agent run and whatever error the CLI emits this time.
    const agent = new CursorAgent();
    const commands: string[] = [];
    let turnCount = 0;
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        turnCount += 1;
        if (turnCount === 1) {
          return { stdout: 'Workspace Trust Required', stderr: '', exitCode: 2 };
        }
        return { stdout: makeCursorResultNdjson({ sessionId: 'recovered' }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'first' });
    await session.reply({ message: 'second' });

    const cursorCmds = commands.filter(isCursorPromptCommand);
    expect(cursorCmds[0]).not.toContain('--resume');
    expect(cursorCmds[1]).not.toContain('--resume');
  });

  it('preserves session_id across three turns (runConversation-style)', async () => {
    const agent = new CursorAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isCursorPromptCommand(cmd)) {
        return {
          stdout: makeCursorResultNdjson({ sessionId: 'sess-42', result: 'ack' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(workspace, mockRunCommand);
    await session.start({ message: 'turn 1' });
    await session.reply({ message: 'turn 2' });
    await session.reply({ message: 'turn 3' });

    const cursorCmds = commands.filter(isCursorPromptCommand);
    expect(cursorCmds).toHaveLength(3);
    expect(cursorCmds[0]).not.toContain('--resume');
    expect(cursorCmds[1]).toContain('--resume sess-42');
    expect(cursorCmds[2]).toContain('--resume sess-42');
  });

  it('run() returns the visible assistant message from a successful stream-json turn', async () => {
    const agent = new CursorAgent();
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (isCursorPromptCommand(cmd)) {
        return {
          stdout: makeCursorResultNdjson({ result: 'hello from cursor' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const out = await agent.run('hi', workspace, mockRunCommand);
    expect(out).toContain('hello from cursor');
  });
});
