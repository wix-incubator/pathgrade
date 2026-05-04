import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAgent } from '../src/agents/claude.js';
import { CodexAgent } from '../src/agents/codex.js';
import { CursorAgent } from '../src/agents/cursor.js';
import { createAgentEnvironment, getAgentNames } from '../src/agents/registry.js';
import { CommandResult } from '../src/types.js';
import { AGENT_CAPABILITIES } from '../src/sdk/types.js';
import { NONINTERACTIVE_RUNTIME_POLICY, renderRuntimePolicy } from '../src/sdk/runtime-policy.js';

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

function isClaudePromptCommand(cmd: string): boolean {
  return /(?:^|[/"\s])claude"?\s+-p\b/.test(cmd);
}

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

  it('passes an explicit model to the Claude CLI when provided', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (isClaudePromptCommand(cmd)) {
        return { stdout: makeClaudeEnvelope('Hello from Claude'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, {
      model: 'claude-sonnet-4-20250514',
    });
    await session.start({ message: 'Test instruction' });

    const claudeCmd = commands.find(isClaudePromptCommand);
    expect(claudeCmd).toContain('--model claude-sonnet-4-20250514');
  });

  it('prefers a stable host claude binary over a temporary yarn shim on PATH', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-claude-path-'));
    const hostRoot = await fs.mkdtemp(path.join(process.cwd(), '.pg-claude-host-'));
    const yarnShimDir = path.join(tempRoot, 'xfs-shim');
    const hostBinDir = path.join(hostRoot, 'host-bin');
    const yarnShimPath = path.join(yarnShimDir, 'claude');
    const hostClaudePath = path.join(hostBinDir, 'claude');
    const originalPath = process.env.PATH;

    await fs.ensureDir(yarnShimDir);
    await fs.ensureDir(hostBinDir);
    await fs.writeFile(yarnShimPath, '#!/bin/sh\necho shim\n');
    await fs.writeFile(hostClaudePath, '#!/bin/sh\necho host\n');
    await fs.chmod(yarnShimPath, 0o755);
    await fs.chmod(hostClaudePath, 0o755);

    process.env.PATH = `${yarnShimDir}:${hostBinDir}`;

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes(hostClaudePath)) {
        return { stdout: makeClaudeEnvelope('Hello from Claude'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    try {
      await agent.run('Test instruction', '/workspace', mockRunCommand);
    } finally {
      process.env.PATH = originalPath;
      await fs.remove(tempRoot);
      await fs.remove(hostRoot);
    }

    expect(commands[1]).toContain(hostClaudePath);
    expect(commands[1]).not.toContain(yarnShimPath);
  });

  it('prefers a stable host claude binary over a repo-local node_modules shim on PATH', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const repoRoot = await fs.mkdtemp(path.join(process.cwd(), '.pg-claude-repo-'));
    const repoShimDir = path.join(repoRoot, 'node_modules', '.bin');
    const hostRoot = await fs.mkdtemp(path.join(process.cwd(), '.pg-claude-host-'));
    const hostBinDir = path.join(hostRoot, 'host-bin');
    const repoShimPath = path.join(repoShimDir, 'claude');
    const hostClaudePath = path.join(hostBinDir, 'claude');
    const originalPath = process.env.PATH;

    await fs.ensureDir(repoShimDir);
    await fs.ensureDir(hostBinDir);
    await fs.writeFile(repoShimPath, '#!/bin/sh\necho shim\n');
    await fs.writeFile(hostClaudePath, '#!/bin/sh\necho host\n');
    await fs.chmod(repoShimPath, 0o755);
    await fs.chmod(hostClaudePath, 0o755);

    process.env.PATH = `${repoShimDir}:${hostBinDir}`;

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes(hostClaudePath)) {
        return { stdout: makeClaudeEnvelope('Hello from Claude'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    try {
      await agent.run('Test instruction', '/workspace', mockRunCommand);
    } finally {
      process.env.PATH = originalPath;
      await fs.remove(repoRoot);
      await fs.remove(hostRoot);
    }

    expect(commands[1]).toContain(hostClaudePath);
    expect(commands[1]).not.toContain(repoShimPath);
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

  it('extracts structured blocked prompts and preserves raw completion text separately', async () => {
    const agent = new ClaudeAgent();
    const ndjson = JSON.stringify({
      type: 'result',
      result: 'I will continue once I have your approval.',
      session_id: 'sess-123',
      permission_denials: [{
        tool_name: 'AskUserQuestion',
        tool_use_id: 'toolu_approve',
        tool_input: {
          questions: [{
            question: 'Should I continue with the release?',
            header: 'Approval needed',
            options: [
              { label: 'Yes', description: 'Continue now' },
              { label: 'No', description: 'Stop here' },
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

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'Test' });

    expect(result.assistantMessage).toBe('I will continue once I have your approval.');
    expect(result.visibleAssistantMessageSource).toBe('blocked_prompt');
    expect(result.visibleAssistantMessage).toContain('Approval needed');
    expect(result.visibleAssistantMessage).toContain('Should I continue with the release?');
    expect(result.visibleAssistantMessage).toContain('Yes');
    expect(result.visibleAssistantMessage).not.toContain('I will continue once I have your approval.');
    expect(result.blockedPrompts).toEqual([
      {
        prompt: 'Should I continue with the release?',
        header: 'Approval needed',
        options: [
          { label: 'Yes', description: 'Continue now' },
          { label: 'No', description: 'Stop here' },
        ],
        sourceTool: 'AskUserQuestion',
        toolUseId: 'toolu_approve',
        order: 0,
      },
    ]);
    expect(result.rawOutput).toBe('I will continue once I have your approval.');
  });

  it('preserves API error text in rawOutput but blanks assistantMessage', async () => {
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

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'Test' });
    // Error text preserved in rawOutput for diagnostics
    expect(result.rawOutput).toContain('API Error');
    // But not in assistantMessage (would corrupt conversation)
    expect(result.assistantMessage).toBe('');
  });

  it('preserves error text in rawOutput when is_error is true', async () => {
    const agent = new ClaudeAgent();
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Invalid API key · Fix external API key',
      session_id: 'sess-123',
      is_error: true,
    });

    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      if (cmd.includes('claude')) {
        return { stdout: envelope, stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    const result = await session.start({ message: 'Test' });
    // Error text should be in rawOutput for diagnostics
    expect(result.rawOutput).toContain('Invalid API key');
    // But assistantMessage should be empty (don't corrupt conversation)
    expect(result.assistantMessage).toBe('');
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
    expect(isClaudePromptCommand(commands[1])).toBe(true);
    expect(commands[1]).toContain('--output-format stream-json');
    expect(commands[1]).not.toContain('--resume');

    // Second turn: uses --resume with session_id from first turn
    expect(commands[3]).toContain('--resume test-session-123');
    expect(commands[3]).toContain('--dangerously-skip-permissions');
  });

  it('includes --mcp-config flag when mcpConfigPath is provided', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('base64')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
        stderr: '',
        exitCode: 0,
      };
    });

    const session = await agent.createSession('workspace', mockRunCommand, { mcpConfigPath: '.pathgrade-mcp.json' });
    await session.start({ message: 'test' });

    const claudeCmd = commands.find(isClaudePromptCommand);
    expect(claudeCmd).toContain('--mcp-config');
    expect(claudeCmd).toContain('.pathgrade-mcp.json');
  });

  it('omits --mcp-config flag when mcpConfigPath is not provided', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('base64')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return {
        stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
        stderr: '',
        exitCode: 0,
      };
    });

    const session = await agent.createSession('workspace', mockRunCommand);
    await session.start({ message: 'test' });

    const claudeCmd = commands.find(isClaudePromptCommand);
    expect(claudeCmd).not.toContain('--mcp-config');
  });

  it('injects runtime policy only on the first Claude turn and reports the applied policy', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('claude')) {
        return {
          stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, {
      runtimePolicies: [NONINTERACTIVE_RUNTIME_POLICY],
    });
    const firstResult = await session.start({ message: 'First user message' });
    const secondResult = await session.reply({ message: 'Second user message' });

    const firstPrompt = decodePromptWriteCommand(commands[0]);
    const secondPrompt = decodePromptWriteCommand(commands[2]);
    const renderedPolicy = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'claude' });

    expect(firstPrompt).toContain(renderedPolicy);
    expect(firstPrompt).toContain('First user message');
    expect(secondPrompt).toContain('Second user message');
    expect(secondPrompt).not.toContain(renderedPolicy);
    expect(firstResult.runtimePoliciesApplied).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
    expect(secondResult.runtimePoliciesApplied).toEqual([]);
  });

  it('keeps slash commands on the first line when injecting Claude runtime policies', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const firstMessage = '/ck-artifact-ingest Add this new material.\n\nShopify launched native prepaid support.';
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      if (cmd.includes('claude')) {
        return {
          stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, {
      runtimePolicies: [NONINTERACTIVE_RUNTIME_POLICY],
    });
    await session.start({ message: firstMessage });

    const firstPrompt = decodePromptWriteCommand(commands[0]);
    const renderedPolicy = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'claude' });

    expect(firstPrompt.startsWith('/ck-artifact-ingest Add this new material.')).toBe(true);
    expect(firstPrompt).toContain(renderedPolicy);
    expect(firstPrompt).toContain('Shopify launched native prepaid support.');
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
  it('runs codex exec without inline auth (auth handled by workspace layer)', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('codex exec');
    expect(commands[0]).toContain(' < ');
  });

  it('writes instruction via temp file and runs codex exec with non-git workspace support', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const result = await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('codex exec');
    expect(commands[0]).toContain('--full-auto');
    expect(commands[0]).toContain('--skip-git-repo-check');
    expect(commands[0]).toContain(' < ');

    const promptPath = extractPromptPath(commands[0]);
    expect(await fs.readFile(promptPath, 'utf8')).toBe('Test instruction');
    expect(result).toContain('output');
  });

  it('uses a custom HTTP-only provider when OPENAI_BASE_URL is set', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('model_provider=');
    expect(commands[0]).toContain('model_providers.pathgrade_openai_proxy.base_url=');
    expect(commands[0]).toContain('model_providers.pathgrade_openai_proxy.env_key=');
    expect(commands[0]).toContain('model_providers.pathgrade_openai_proxy.supports_websockets=false');
    expect(commands[0]).toContain('$OPENAI_BASE_URL');
  });

  it('passes an explicit default codex model to the CLI', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    await agent.run('Test instruction', '/workspace', mockRunCommand);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('-m');
    expect(commands[0]).toContain('gpt-5.3-codex');
  });

  it('uses the session model override when provided', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, { model: 'gpt-5.4' });
    await session.start({ message: 'Test instruction' });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('-m');
    expect(commands[0]).toContain('gpt-5.4');
  });

  it('falls back to transcript accumulation for session replies', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    let cliCallCount = 0;
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      cliCallCount++;
      return {
        stdout: cliCallCount === 1 ? 'assistant one' : 'assistant two',
        stderr: '',
        exitCode: 0,
      };
    });

    const session = await agent.createSession('/workspace', mockRunCommand);
    await session.start({ message: 'First user message' });
    await session.reply({ message: 'Second user message', continueSession: true });

    expect(commands[0]).toContain('codex exec');
    expect(commands[1]).toContain('codex exec');

    const secondPrompt = await fs.readFile(extractPromptPath(commands[1]), 'utf8');
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
  });

  it('codex agent does not handle auth inline (auth resolved by workspace layer)', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'output', stderr: '', exitCode: 0 };
    });

    await agent.run('Test instruction', '/workspace', mockRunCommand);

    // Only codex exec — no auth commands from the agent
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('codex exec');
    expect(commands[0]).not.toContain('codex login');
  });

  it('keeps the full Codex trace in traceOutput but only the final answer in assistantMessage', async () => {
    const agent = new CodexAgent();
    const mockRunCommand = vi.fn()
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

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain('base64');
    const promptPath = extractPromptPath(commands[0]);
    expect(await fs.readFile(promptPath, 'utf8')).toBe(largeMessage);
  });

  it('rebuilds Codex transcript prompts with the runtime policy on every turn without leaking it into history', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    let cliCallCount = 0;
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      cliCallCount++;
      return {
        stdout: cliCallCount === 1 ? 'assistant one' : 'assistant two',
        stderr: '',
        exitCode: 0,
      };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, {
      runtimePolicies: [NONINTERACTIVE_RUNTIME_POLICY],
    });
    const firstResult = await session.start({ message: 'First user message' });
    const secondResult = await session.reply({ message: 'Second user message', continueSession: true });

    const firstPrompt = await fs.readFile(extractPromptPath(commands[0]), 'utf8');
    const secondPrompt = await fs.readFile(extractPromptPath(commands[1]), 'utf8');
    const renderedPolicy = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'codex' });

    expect(firstPrompt).toContain(renderedPolicy);
    expect(secondPrompt).toContain(renderedPolicy);
    expect(secondPrompt.split(renderedPolicy)).toHaveLength(2);
    expect(secondPrompt).toContain('First user message');
    expect(secondPrompt).toContain('assistant one');
    expect(secondPrompt).toContain('Second user message');
    expect(firstResult.runtimePoliciesApplied).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
    expect(secondResult.runtimePoliciesApplied).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
  });

  it('does not inject the Codex runtime policy when the session does not require it', async () => {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession('/workspace', mockRunCommand, { runtimePolicies: [] });
    await session.start({ message: 'First user message' });

    const prompt = await fs.readFile(extractPromptPath(commands[0]), 'utf8');
    const renderedPolicy = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'codex' });

    expect(prompt).not.toContain(renderedPolicy);
  });
});

describe('CursorAgent registration', () => {
  it('is registered in AGENT_REGISTRY under "cursor"', () => {
    expect(getAgentNames()).toContain('cursor');
    const agent = createAgentEnvironment('cursor');
    expect(agent).toBeInstanceOf(CursorAgent);
  });

  it('declares noninteractive ask-user transport and MCP + native session support', () => {
    expect(AGENT_CAPABILITIES.cursor).toEqual({
      mcp: true,
      nativeSession: true,
      interactiveQuestionTransport: 'noninteractive',
    });
  });
});
