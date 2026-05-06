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

  // The Claude-specific NDJSON traceOutput test that lived here covered the
  // pre-SDK CLI driver's stream-json scrape. The SDK driver consumes typed
  // messages instead, so traceOutput is no longer the projection surface for
  // tool extraction. Coverage moves to the SDK message projector tests in
  // issue #002 (`tests/claude-sdk-projector.test.ts`).
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
