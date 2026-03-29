# Codex MCP Support Patch Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing MCP config and mock-server design so Codex can use the same eval-authored `mcp_config` / `mcp_mock` inputs during PathGrade runs.

**Architecture:** Keep the eval-facing schema and task-bundle artifact unchanged: all MCP inputs still normalize to `.pathgrade-mcp.json` in the workspace. Claude continues to consume that file via `--mcp-config`; Codex gets a small adapter that reads the same file from the trial workspace, validates the supported server shapes, registers them with `codex mcp add` once per trial/session, and then runs the existing `codex exec` flow. The session interface becomes agent-aware instead of Claude-only so transcript-based agents can consume runtime options.

**Tech Stack:** TypeScript, Vitest, Codex CLI (`codex-cli 0.117.0-alpha.10`) contract

**Depends on:** `docs/superpowers/plans/2026-03-28-mcp-config-support.md`, `docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `docs/superpowers/plans/2026-03-28-mcp-config-support.md` | Modify | Replace Claude-only runtime assumptions with agent-aware wording |
| `docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md` | Modify | Patch mock-server design so `.pathgrade-mcp.json` is consumed by agent-specific adapters |
| `src/types.ts` | Modify | Thread `AgentSessionOptions` through the generic session interface |
| `src/agents/transcript-agent.ts` | Modify | Pass runtime + session options into transcript-agent turns |
| `src/agents/gemini.ts` | Modify | Accept and ignore MCP session options |
| `src/agents/codex.ts` | Modify | Bootstrap MCP registrations before `codex exec` |
| `src/agents/codex-mcp.ts` | Create | Parse normalized MCP JSON and build safe `codex mcp add` commands |
| `src/evalRunner.ts` | Modify | Pass `mcpConfigPath` into agent sessions in single-turn and conversation flows |
| `src/conversationRunner.ts` | Modify | Pass `mcpConfigPath` through to transcript agents |
| `src/commands/run.ts` | Modify | Keep staging `.pathgrade-mcp.json` and pass the same option for Codex runs |
| `tests/codex-mcp.test.ts` | Create | Unit tests for normalized MCP parsing and Codex command generation |
| `tests/agents.test.ts` | Modify | Codex bootstrap tests and updated transcript-agent signature coverage |
| `tests/commands.run.test.ts` | Modify | Verify `.pathgrade-mcp.json` staging remains correct for real/mock MCP |

---

### Task 1: Patch The Existing MCP Docs

**Files:**
- Modify: `docs/superpowers/plans/2026-03-28-mcp-config-support.md`
- Modify: `docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md`

- [ ] **Step 1: Patch the base MCP plan header and architecture**

In `docs/superpowers/plans/2026-03-28-mcp-config-support.md`, replace the Claude-only framing:

```md
**Goal:** Allow eval tasks to specify an MCP server config file so supported agents can use MCP tools during evaluation runs.

**Architecture:** Add an optional `mcp_config` field at both task and defaults level. During task resolution, the path is resolved relative to the eval file directory. At runtime, the MCP config file is copied into the trial workspace as `.pathgrade-mcp.json`. Claude consumes it via `--mcp-config`; Codex consumes it through a trial-local bootstrap adapter that registers the servers with `codex mcp add`. Agents that do not support MCP continue to ignore it.
```

- [ ] **Step 2: Patch the file-structure section in the base plan**

Add these rows to the table in `docs/superpowers/plans/2026-03-28-mcp-config-support.md`:

```md
| `src/agents/codex.ts` | Modify | Accept options, bootstrap MCP registrations, then run `codex exec` |
| `src/agents/gemini.ts` | Modify | Accept and ignore agent session options |
| `src/agents/codex-mcp.ts` | Create | Translate normalized MCP config into Codex CLI registration commands |
| `tests/codex-mcp.test.ts` | Create | MCP config parsing + command generation tests |
| `tests/commands.run.test.ts` | Modify | Verify `.pathgrade-mcp.json` staging |
```

- [ ] **Step 3: Patch the mock-server spec’s runtime language**

In `docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md`, replace the Claude-only sections:

```md
PathGrade ships a built-in mock MCP server and helper functions. Eval authors declare tool mocks in their eval config. PathGrade generates the MCP config and fixture files automatically. The runtime then hands the normalized `.pathgrade-mcp.json` to the selected agent adapter. Claude spawns the mock server via `--mcp-config`; Codex registers the same stdio server via `codex mcp add`.
```

Patch the “Step 3 — Set `mcpConfigPath`” paragraph to:

```md
**Step 3 — Set `mcpConfigPath`.** Same as the `mcp_config` flow: `mcpConfigPath: '.pathgrade-mcp.json'` in `EvalRunOptions`. Downstream runners are reused; the agent-specific adapter decides how to consume the config.
```

Patch the end-to-end flow section to:

```md
**Real MCP (`mcp_config`):**

User authors mcp-servers.json
  → resolveTask() resolves to absolute path
  → prepareTempTaskDir() copies file as .pathgrade-mcp.json
  → LocalProvider.setup() copies task bundle to workspace
  → Claude: `claude --mcp-config ".pathgrade-mcp.json"`
  → Codex: bootstrap adapter reads `.pathgrade-mcp.json` and runs `codex mcp add ...`

**Mock MCP (`mcp_mock`):**

User writes mockMcpServer({ name, tools })
  → resolveTask() passes MockMcpServerDescriptor through
  → prepareTempTaskDir() generates fixture JSON + .pathgrade-mcp.json
  → LocalProvider.setup() copies task bundle to workspace
  → Claude: `claude --mcp-config ".pathgrade-mcp.json"`
  → Codex: bootstrap adapter registers `node dist/mcp-mock-server.js ...` with `codex mcp add`
```

- [ ] **Step 4: Add a Codex-compatibility note to the mock spec**

Add this section after the runtime flow in `docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md`:

```md
### Codex Compatibility

Codex support is based on the normalized `.pathgrade-mcp.json` artifact, not on Claude-specific flags.

Supported normalized server shapes:
- stdio: `{ command, args?, env? }`
- HTTP: `{ url, bearerTokenEnvVar? }`

If a resolved MCP server contains fields the Codex adapter cannot express through `codex mcp add`, PathGrade must fail fast for `agent: 'codex'` with a validation error rather than silently dropping behavior.
```

- [ ] **Step 5: Verify the patched docs no longer claim “Codex ignores MCP”**

Run: `cd /Users/nadavlac/projects/pathgrade && rg -n "ignore it since they don't support MCP yet|Claude CLI spawns|No changes to: \`evalRunner.ts\`, \`conversationRunner.ts\`, \`claude.ts\`, \`types.ts\`" docs/superpowers -S`
Expected: no matches that describe the Codex path incorrectly

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-03-28-mcp-config-support.md docs/superpowers/specs/2026-03-29-mcp-mock-servers-design.md
git commit -m "docs: patch MCP specs for codex support"
```

---

### Task 2: Add A Codex MCP Translation Helper

**Files:**
- Create: `src/agents/codex-mcp.ts`
- Test: `tests/codex-mcp.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `tests/codex-mcp.test.ts` with these cases:

```typescript
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCodexMcpSetupCommands,
} from '../src/agents/codex-mcp';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    try { await fs.remove(dir); } catch {}
  }
  tempDirs.length = 0;
});

async function writeConfig(json: unknown): Promise<{ workspace: string; relPath: string }> {
  const workspace = path.join(os.tmpdir(), `pathgrade-codex-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(workspace);
  await fs.ensureDir(workspace);
  await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), json, { spaces: 2 });
  return { workspace, relPath: '.pathgrade-mcp.json' };
}

describe('loadCodexMcpSetupCommands', () => {
  it('builds stdio codex mcp add commands from normalized config', async () => {
    const { workspace, relPath } = await writeConfig({
      mcpServers: {
        weather: {
          command: 'node',
          args: ['dist/mock.js', '.pathgrade-mock.json'],
          env: { API_KEY: 'test-key' },
        },
      },
    });

    const commands = await loadCodexMcpSetupCommands(workspace, relPath);
    expect(commands).toEqual([
      'codex mcp remove "weather" >/dev/null 2>&1 || true',
      'codex mcp add "weather" --env "API_KEY=test-key" -- "node" "dist/mock.js" ".pathgrade-mock.json"',
    ]);
  });

  it('builds HTTP codex mcp add commands with bearer-token env var', async () => {
    const { workspace, relPath } = await writeConfig({
      mcpServers: {
        remote: {
          url: 'https://example.test/mcp',
          bearerTokenEnvVar: 'REMOTE_TOKEN',
        },
      },
    });

    const commands = await loadCodexMcpSetupCommands(workspace, relPath);
    expect(commands).toEqual([
      'codex mcp remove "remote" >/dev/null 2>&1 || true',
      'codex mcp add "remote" --url "https://example.test/mcp" --bearer-token-env-var "REMOTE_TOKEN"',
    ]);
  });

  it('rejects unsupported server shapes', async () => {
    const { workspace, relPath } = await writeConfig({
      mcpServers: {
        broken: {
          command: 'node',
          cwd: '/tmp',
        },
      },
    });

    await expect(loadCodexMcpSetupCommands(workspace, relPath)).rejects.toThrow(/unsupported.*cwd/i);
  });

  it('rejects configs without mcpServers', async () => {
    const { workspace, relPath } = await writeConfig({});
    await expect(loadCodexMcpSetupCommands(workspace, relPath)).rejects.toThrow(/mcpServers/i);
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/codex-mcp.test.ts`
Expected: FAIL because `src/agents/codex-mcp.ts` does not exist yet

- [ ] **Step 3: Implement the minimal helper**

Create `src/agents/codex-mcp.ts`:

```typescript
import fs from 'fs-extra';
import path from 'path';

type NormalizedServer =
  | { command: string; args?: string[]; env?: Record<string, string>; url?: never; bearerTokenEnvVar?: never }
  | { url: string; bearerTokenEnvVar?: string; command?: never; args?: never; env?: never };

interface NormalizedMcpConfig {
  mcpServers: Record<string, NormalizedServer & Record<string, unknown>>;
}

function sh(value: string): string {
  return JSON.stringify(value);
}

export async function loadCodexMcpSetupCommands(
  workspacePath: string,
  mcpConfigPath: string,
): Promise<string[]> {
  const absolutePath = path.resolve(workspacePath, mcpConfigPath);
  const raw = await fs.readJson(absolutePath) as Partial<NormalizedMcpConfig>;

  if (!raw.mcpServers || typeof raw.mcpServers !== 'object') {
    throw new Error(`Invalid MCP config: expected mcpServers object in ${absolutePath}`);
  }

  const commands: string[] = [];

  for (const [name, server] of Object.entries(raw.mcpServers)) {
    const keys = Object.keys(server ?? {});
    const unsupportedKeys = keys.filter(k => !['command', 'args', 'env', 'url', 'bearerTokenEnvVar'].includes(k));
    if (unsupportedKeys.length > 0) {
      throw new Error(`Codex MCP adapter: unsupported fields for server "${name}": ${unsupportedKeys.join(', ')}`);
    }

    commands.push(`codex mcp remove ${sh(name)} >/dev/null 2>&1 || true`);

    if (typeof (server as any).command === 'string') {
      const command = (server as any).command as string;
      const args = Array.isArray((server as any).args) ? (server as any).args : [];
      const env = (server as any).env && typeof (server as any).env === 'object' ? Object.entries((server as any).env) : [];
      const envFlags = env.map(([k, v]) => `--env ${sh(`${k}=${String(v)}`)}`).join(' ');
      const commandParts = [command, ...args].map(part => sh(String(part))).join(' ');
      commands.push(`codex mcp add ${sh(name)}${envFlags ? ` ${envFlags}` : ''} -- ${commandParts}`);
      continue;
    }

    if (typeof (server as any).url === 'string') {
      const bearerTokenEnvVar = (server as any).bearerTokenEnvVar;
      const bearerFlag = bearerTokenEnvVar ? ` --bearer-token-env-var ${sh(String(bearerTokenEnvVar))}` : '';
      commands.push(`codex mcp add ${sh(name)} --url ${sh((server as any).url)}${bearerFlag}`);
      continue;
    }

    throw new Error(`Codex MCP adapter: server "${name}" must use either stdio {command,...} or HTTP {url,...}`);
  }

  return commands;
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/codex-mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/codex-mcp.ts tests/codex-mcp.test.ts
git commit -m "feat: add codex MCP config adapter"
```

---

### Task 3: Thread Session Options Through Transcript Agents

**Files:**
- Modify: `src/types.ts:129-220`
- Modify: `src/agents/transcript-agent.ts:1-54`
- Modify: `src/agents/gemini.ts:1-21`
- Modify: `src/evalRunner.ts:42-60`
- Modify: `src/evalRunner.ts:224-246`
- Modify: `src/conversationRunner.ts:29-44`
- Modify: `src/conversationRunner.ts:319-336`

- [ ] **Step 1: Write a failing Codex agent test that requires session options**

In `tests/agents.test.ts`, add this test inside the `describe('CodexAgent', ...)` block:

```typescript
it('registers MCP servers before codex exec when mcpConfigPath is provided', async () => {
  const tmpDir = path.join(os.tmpdir(), `pathgrade-codex-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.ensureDir(tmpDir);
  await fs.writeJson(path.join(tmpDir, '.pathgrade-mcp.json'), {
    mcpServers: {
      weather: {
        command: 'node',
        args: ['dist/mock.js'],
      },
    },
  });

  try {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(tmpDir, mockRunCommand, { mcpConfigPath: '.pathgrade-mcp.json' });
    await session.start({ message: 'Use MCP' });

    expect(commands.some(cmd => cmd.includes('codex mcp add "weather"'))).toBe(true);
    expect(commands.some(cmd => cmd.includes('codex exec'))).toBe(true);
  } finally {
    await fs.remove(tmpDir);
  }
});
```

- [ ] **Step 2: Run the agent test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts -t "registers MCP servers before codex exec"`
Expected: FAIL because `createSession()` does not thread options into transcript agents yet

- [ ] **Step 3: Add `AgentSessionOptions` and pass it through the generic interface**

In `src/types.ts`, add:

```typescript
export interface AgentSessionOptions {
    mcpConfigPath?: string;
}
```

Update `BaseAgent.createSession()` and `createAgentSession()`:

```typescript
async createSession(
  runtime: EnvironmentHandle,
  runCommand: AgentCommandRunner,
  _options?: AgentSessionOptions
): Promise<AgentSession> {
```

```typescript
export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner,
    options?: AgentSessionOptions
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand, options);
}
```

- [ ] **Step 4: Update `TranscriptAgent` to forward runtime + options to each turn**

In `src/agents/transcript-agent.ts`, change the import and the abstract method:

```typescript
import {
  AgentCommandRunner,
  AgentSession,
  AgentSessionOptions,
  AgentTurnResult,
  BaseAgent,
  CommandResult,
  EnvironmentHandle,
} from '../types';
```

```typescript
async createSession(
  runtime: EnvironmentHandle,
  runCommand: AgentCommandRunner,
  options?: AgentSessionOptions
): Promise<AgentSession> {
  const transcript: string[] = [];

  const runTranscriptTurn = async (message: string): Promise<AgentTurnResult> => {
    transcript.push(`User: ${message}`);
    const result = await this.runTurn(this.buildTranscriptPrompt(transcript), runtime, runCommand, options);
    transcript.push(`Assistant: ${result.assistantMessage}`);
    return result;
  };

  return {
    start: async ({ message }) => runTranscriptTurn(message),
    reply: async ({ message }) => runTranscriptTurn(message),
  };
}

protected abstract runTurn(
  instruction: string,
  runtime: EnvironmentHandle,
  runCommand: AgentCommandRunner,
  options?: AgentSessionOptions
): Promise<AgentTurnResult>;
```

Update `run()` accordingly:

```typescript
const result = await this.runTurn(instruction, _workspacePath, runCommand);
```

- [ ] **Step 5: Update Gemini and runner call sites**

In `src/agents/gemini.ts`, update the signature only:

```typescript
import { AgentCommandRunner, AgentSessionOptions, AgentTurnResult, EnvironmentHandle } from '../types';

protected async runTurn(
  instruction: string,
  _runtime: EnvironmentHandle,
  runCommand: AgentCommandRunner,
  _options?: AgentSessionOptions
): Promise<AgentTurnResult> {
```

In `src/evalRunner.ts`, add `mcpConfigPath?: string` to `EvalRunOptions` and pass session options into `createAgentSession(...)`:

```typescript
const sessionOptions = opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : undefined;
const session = await createAgentSession(agent, runtime, loggedRunCommand, sessionOptions);
```

In `src/conversationRunner.ts`, add `mcpConfigPath?: string` to `ConversationRunOptions` and pass:

```typescript
const sessionOptions = opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : undefined;
const session = await createAgentSession(opts.agent, opts.runtime, async (...) => { ... }, sessionOptions);
```

- [ ] **Step 6: Run the targeted test to verify it now reaches the Codex path**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts -t "registers MCP servers before codex exec"`
Expected: still FAIL, but now because `CodexAgent` has not implemented MCP bootstrap yet

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agents/transcript-agent.ts src/agents/gemini.ts src/evalRunner.ts src/conversationRunner.ts tests/agents.test.ts
git commit -m "feat: thread MCP session options through transcript agents"
```

---

### Task 4: Implement Codex MCP Bootstrap In The Agent

**Files:**
- Modify: `src/agents/codex.ts:1-33`
- Modify: `src/commands/run.ts:135-160`
- Test: `tests/agents.test.ts:502-619`
- Test: `tests/commands.run.test.ts`

- [ ] **Step 1: Extend the Codex agent tests to cover one-time bootstrap and no-op behavior**

Add these tests to `tests/agents.test.ts`:

```typescript
it('bootstraps MCP only once across a multi-turn Codex session', async () => {
  const tmpDir = path.join(os.tmpdir(), `pathgrade-codex-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.ensureDir(tmpDir);
  await fs.writeJson(path.join(tmpDir, '.pathgrade-mcp.json'), {
    mcpServers: {
      weather: { command: 'node', args: ['dist/mock.js'] },
    },
  });

  try {
    const agent = new CodexAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
      commands.push(cmd);
      return { stdout: 'assistant', stderr: '', exitCode: 0 };
    });

    const session = await agent.createSession(tmpDir, mockRunCommand, { mcpConfigPath: '.pathgrade-mcp.json' });
    await session.start({ message: 'First turn' });
    await session.reply({ message: 'Second turn', continueSession: true });

    expect(commands.filter(cmd => cmd.includes('codex mcp add "weather"'))).toHaveLength(1);
    expect(commands.filter(cmd => cmd.includes('codex exec'))).toHaveLength(2);
  } finally {
    await fs.remove(tmpDir);
  }
});

it('skips MCP bootstrap when mcpConfigPath is not provided', async () => {
  const agent = new CodexAgent();
  const commands: string[] = [];
  const mockRunCommand = vi.fn().mockImplementation(async (cmd: string): Promise<CommandResult> => {
    commands.push(cmd);
    return { stdout: 'assistant', stderr: '', exitCode: 0 };
  });

  await agent.run('Test instruction', '/workspace', mockRunCommand);

  expect(commands.some(cmd => cmd.includes('codex mcp add'))).toBe(false);
  expect(commands.some(cmd => cmd.includes('codex exec'))).toBe(true);
});
```

- [ ] **Step 2: Run the Codex agent tests to verify they fail**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts -t "CodexAgent|registers MCP servers before codex exec|bootstraps MCP only once|skips MCP bootstrap"`
Expected: FAIL because `src/agents/codex.ts` does not consume `mcpConfigPath`

- [ ] **Step 3: Implement one-time bootstrap in `CodexAgent`**

In `src/agents/codex.ts`, update the implementation:

```typescript
import { getWorkspacePath, AgentCommandRunner, AgentSessionOptions, AgentTurnResult, EnvironmentHandle } from '../types';
import { loadCodexMcpSetupCommands } from './codex-mcp';
import { TranscriptAgent } from './transcript-agent';

export class CodexAgent extends TranscriptAgent {
    private bootstrappedMcpConfigPath?: string;

    protected async runTurn(
        instruction: string,
        runtime: EnvironmentHandle,
        runCommand: AgentCommandRunner,
        options?: AgentSessionOptions
    ): Promise<AgentTurnResult> {
        if (options?.mcpConfigPath && this.bootstrappedMcpConfigPath !== options.mcpConfigPath) {
            const commands = await loadCodexMcpSetupCommands(getWorkspacePath(runtime), options.mcpConfigPath);
            for (const command of commands) {
                const result = await runCommand(command);
                if (result.exitCode !== 0) {
                    throw new Error(`Codex MCP bootstrap failed: ${command}`);
                }
            }
            this.bootstrappedMcpConfigPath = options.mcpConfigPath;
        }

        await runCommand('if [ "${PATHGRADE_CODEX_USE_HOST_AUTH:-0}" != "1" ] && [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi');

        const promptPath = await this.writePromptFile(instruction, runCommand);
        const quotedPromptPath = JSON.stringify(promptPath);
        const command = 'if [ "${PATHGRADE_CODEX_USE_HOST_AUTH:-0}" = "1" ]; then ' +
            `env -u OPENAI_API_KEY -u OPENAI_BASE_URL codex exec --full-auto --skip-git-repo-check - < ${quotedPromptPath}; ` +
            'else ' +
            `codex exec --full-auto --skip-git-repo-check - < ${quotedPromptPath}; ` +
            'fi';
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\\n' + result.stderr;
        const assistantMessage = result.stdout.trim() || rawOutput.trim();

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage,
            exitCode: result.exitCode,
            traceOutput: rawOutput,
        };
    }
}
```

- [ ] **Step 4: Keep runner wiring agent-agnostic**

In `src/commands/run.ts`, make sure `mcpConfigPath` is passed whenever `resolved.mcp_config` exists, regardless of agent:

```typescript
mcpConfigPath: resolved.mcp_config ? '.pathgrade-mcp.json' : undefined,
```

Do not add an `agentName === 'claude'` guard here. The adapter choice belongs inside the agent implementation.

- [ ] **Step 5: Add a staging test for `.pathgrade-mcp.json`**

In `tests/commands.run.test.ts`, add:

```typescript
it('copies resolved mcp_config into .pathgrade-mcp.json', async () => {
  const baseDir = makeBaseDir();
  const tmpDir = makeTmpDir();
  await fsExtra.ensureDir(baseDir);
  await fsExtra.writeJson(path.join(baseDir, 'mcp-servers.json'), {
    mcpServers: {
      weather: { command: 'node', args: ['dist/mock.js'] },
    },
  });

  const resolved = makeResolvedTask({
    mcp_config: path.join(baseDir, 'mcp-servers.json'),
  });

  await prepareTempTaskDir(resolved, baseDir, tmpDir);

  expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade-mcp.json'))).toBe(true);
  expect(await fsExtra.readJson(path.join(tmpDir, '.pathgrade-mcp.json'))).toEqual({
    mcpServers: {
      weather: { command: 'node', args: ['dist/mock.js'] },
    },
  });
});
```

- [ ] **Step 6: Run the targeted tests**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts tests/commands.run.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agents/codex.ts src/commands/run.ts tests/agents.test.ts tests/commands.run.test.ts
git commit -m "feat: bootstrap MCP support for codex runs"
```

---

### Task 5: Verify End-To-End MCP Wiring Still Works For Both Agents

**Files:** None (verification only)

- [ ] **Step 1: Run the focused MCP-related test set**

Run:

```bash
cd /Users/nadavlac/projects/pathgrade
npx vitest run tests/codex-mcp.test.ts tests/agents.test.ts tests/commands.run.test.ts tests/config.test.ts tests/define-eval.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS

- [ ] **Step 3: Run the TypeScript compiler**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc --noEmit`
Expected: PASS with no type errors

- [ ] **Step 4: Manual smoke-check against the local Codex CLI contract**

Run:

```bash
cd /Users/nadavlac/projects/pathgrade
codex --version
codex mcp add --help
codex exec --help
```

Expected:
- `codex --version` reports the expected CLI family
- `codex mcp add --help` still supports `--env`, `--url`, and `--bearer-token-env-var`
- `codex exec --help` still does not require a direct `--mcp-config` flag, confirming the bootstrap adapter path is still necessary

- [ ] **Step 5: Final commit if any verification-only fixes were needed**

```bash
git add -A
git commit -m "test: verify codex MCP support end to end"
```
