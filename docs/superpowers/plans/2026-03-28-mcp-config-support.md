# MCP Config Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow eval tasks to specify an MCP server config file so the Claude agent can use MCP tools during evaluation runs.

**Architecture:** Add an optional `mcp_config` field at both task and defaults level. During task resolution, the path is resolved relative to the eval file directory. At runtime, the MCP config file is copied into the trial workspace and the Claude CLI command is extended with `--mcp-config`. Other agents (Gemini, Codex) ignore it since they don't support MCP yet.

**Tech Stack:** TypeScript, vitest

**Status:** Partially implemented. The MCP mock servers plan (`2026-03-29-mcp-mock-servers.md`) already added `mcp_config` to types, threading, and resolution. What remains is the runtime wiring: copying the config file, threading `mcpConfigPath` through the agent session interface, and appending `--mcp-config` to the Claude CLI command.

**Constraint — absolute paths in MCP configs:** MCP config files must use absolute paths or global commands (e.g. `npx`, HTTP URLs) for server entries. The config is copied verbatim into the trial workspace — relative paths inside it are NOT rewritten. This matches real-world MCP configs (absolute paths, `npx` commands, HTTP URLs) and avoids fragile path rewriting inside arbitrary JSON.

**Constraint — no base-dir containment check:** Unlike workspace files, `mcp_config` is intentionally allowed to reference files outside the eval directory (e.g. `~/.claude.json`). The eval author explicitly opts in to this path. Workspace files are sandboxed because they're copied into a shared trial context; the MCP config is a reference chosen by the eval author.

**Constraint — no fail-fast pathExists in resolveTask:** File existence is validated at copy time in `prepareTempTaskDir`, not during resolution. This avoids conflicts with mocked `pathExists` in existing tests (which mock it globally for instruction resolution) and follows the validate-at-point-of-use principle.

---

## Already Done (from mock servers plan)

These items were implemented as part of the MCP mock servers plan and should NOT be re-implemented:

- [x] `mcp_config?: string` added to `EvalTaskBase`, `EvalDefaults`, `ResolvedTaskBase`, `DefineEvalTaskBase` in `config.types.ts`
- [x] `mcp_config` passthrough in `defineEval` (`define-eval.ts:31`)
- [x] `mcp_config` on `RawTask` interface in `config.ts:55`
- [x] `mcp_config` passthrough in `validateConfig` base object (`config.ts:292`)
- [x] `mcp_config` resolution in `resolveTask` — `path.resolve(baseDir, mcp_config_raw)` (`config.ts:432-434`)
- [x] Mutual exclusion with `mcp_mock` in `resolveTask` (`config.ts:437-439`)
- [x] `mcp_config` in both `resolveTask` return objects (`config.ts:465,479`)
- [x] `mcpConfigPath?: string` on `EvalRunOptions` (`evalRunner.ts:61`)
- [x] `mcpConfigPath` set in `evalOpts` — `(resolved.mcp_config || resolved.mcp_mock) ? '.pathgrade-mcp.json' : undefined` (`run.ts:140`)

Note: `RawEvalConfig.defaults` is typed as `Record<string, unknown> & {...}` (config.ts:29), so `mcp_config` already passes through the defaults spread at config.ts:149 without needing an explicit field. The existing `mcp_mock` defaults test at define-eval.test.ts:216 proves this path works. Adding `mcp_config` to the explicit type is optional (for documentation, not correctness).

## File Structure (remaining work)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/commands/run.ts:315-348` | Modify | Copy `mcp_config` file into workspace in `prepareTempTaskDir` |
| `src/types.ts:172-200` | Modify | Add `AgentSessionOptions`, update `BaseAgent.createSession` and `createAgentSession` |
| `src/agents/claude.ts:27-68` | Modify | Accept options, append `--mcp-config` flag |
| `src/agents/transcript-agent.ts:13` | Modify | Accept and ignore options (forward-compat) |
| `src/evalRunner.ts:190-250` | Modify | Pass `mcpConfigPath` to conversation runner and agent session |
| `src/conversationRunner.ts:33-42,319` | Modify | Add `mcpConfigPath` to options, pass to `createAgentSession` |
| `tests/define-eval.test.ts` | Modify | Add `mcp_config` passthrough tests |
| `tests/config.test.ts` | Modify | Add `mcp_config` resolution tests |
| `tests/commands.run.test.ts` | Modify | Add `mcp_config` file staging tests |
| `tests/agents.test.ts` | Modify | Add ClaudeAgent `--mcp-config` flag tests |

---

### Task 1: Add tests for existing `mcp_config` support

All type and resolution work is already done. This task adds test coverage to confirm it works.

**Files:**
- Modify: `tests/define-eval.test.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Add `mcp_config` passthrough tests to `defineEval`**

In `tests/define-eval.test.ts`, add after the existing `mcp_mock` tests:

```typescript
it('passes mcp_config through on task', () => {
  const config = defineEval({
    tasks: [
      {
        name: 'mcp-task',
        type: 'instruction',
        instruction: 'use mcp',
        mcp_config: './mcp-servers.json',
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      },
    ],
  });

  expect(config.tasks[0].mcp_config).toBe('./mcp-servers.json');
});

it('passes mcp_config through on defaults', () => {
  const config = defineEval({
    defaults: { mcp_config: './default-mcp.json' },
    tasks: [
      {
        name: 'mcp-task',
        type: 'instruction',
        instruction: 'use mcp',
        graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
      },
    ],
  });

  expect(config.defaults.mcp_config).toBe('./default-mcp.json');
});
```

- [ ] **Step 2: Add `mcp_config` resolution tests to `resolveTask`**

In `tests/config.test.ts`, add to the `resolveTask` describe block (after the existing `mcp_mock` tests):

```typescript
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
```

- [ ] **Step 3: Run all tests to verify they pass**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/define-eval.test.ts tests/config.test.ts`
Expected: PASS — all new tests pass immediately (types and resolution already implemented)

- [ ] **Step 4: Commit**

```bash
git add tests/define-eval.test.ts tests/config.test.ts
git commit -m "test: add mcp_config passthrough and resolution tests"
```

---

### Task 2: Thread MCP config through the agent interface

**Files:**
- Modify: `src/types.ts:158-200` (AgentSessionOptions, BaseAgent, createAgentSession)
- Modify: `src/agents/claude.ts:27-68` (createSession, runTurn)
- Modify: `src/agents/transcript-agent.ts:13` (createSession signature)

- [ ] **Step 1: Add `AgentSessionOptions` to types.ts**

In `src/types.ts`, add the new interface before `BaseAgent` (around line 170):

```typescript
export interface AgentSessionOptions {
    mcpConfigPath?: string;
}
```

Update `BaseAgent.createSession` to accept the options parameter (line 173):

```typescript
export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        // Default: wrap run() into a session for simple agents
        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const rawOutput = await this.run(message, getWorkspacePath(runtime), runCommand);
            return { rawOutput, assistantMessage: rawOutput, exitCode: 0, traceOutput: rawOutput };
        };
        return {
            start: async ({ message }) => runTurn(message),
            reply: async ({ message }) => runTurn(message),
        };
    }

    run(
        _instruction: string,
        _workspacePath: string,
        _runCommand: AgentCommandRunner
    ): Promise<string> {
        throw new Error('Agent must implement createSession() or run()');
    }
}
```

Update `createAgentSession` to pass options through (line 194):

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

- [ ] **Step 2: Update TranscriptAgent to accept options**

In `src/agents/transcript-agent.ts`, update the import and `createSession` signature (line 5, 13):

```typescript
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';
```

```typescript
async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, _options?: AgentSessionOptions): Promise<AgentSession> {
```

- [ ] **Step 3: Update ClaudeAgent to use `mcpConfigPath`**

In `src/agents/claude.ts`, update the import (line 1):

```typescript
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';
```

Update `createSession` to accept options and pass `mcpConfigPath` (line 27):

```typescript
async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
    let sessionId: string | undefined;
    const mcpConfigPath = options?.mcpConfigPath;

    return {
        start: async ({ message }) => {
            const result = await this.runTurn(message, runCommand, undefined, mcpConfigPath);
            sessionId = result.sessionId;
            return result;
        },
        reply: async ({ message }) => {
            const result = await this.runTurn(message, runCommand, sessionId, mcpConfigPath);
            return result;
        },
    };
}
```

Update `run` method (line 43):

```typescript
async run(
    instruction: string,
    _workspacePath: string,
    runCommand: (cmd: string) => Promise<CommandResult>
): Promise<string> {
    const result = await this.runTurn(instruction, runCommand, undefined, undefined);
    return result.rawOutput;
}
```

Update `runTurn` to accept and use `mcpConfigPath` (line 52):

```typescript
private async runTurn(
    instruction: string,
    runCommand: AgentCommandRunner,
    sessionId: string | undefined,
    mcpConfigPath: string | undefined
): Promise<AgentTurnResult & { sessionId?: string }> {
    const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

    const b64 = Buffer.from(instruction).toString('base64');
    await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

    const sanitized = sessionId ? this.sanitizeSessionId(sessionId) : undefined;
    const sessionFlag = sanitized ? ` --resume ${sanitized}` : '';
    const mcpFlag = mcpConfigPath ? ` --mcp-config "${mcpConfigPath}"` : '';
    const command = `claude -p${sessionFlag}${mcpFlag} --output-format stream-json --verbose --dangerously-skip-permissions "$(cat ${promptPath})" < /dev/null`;
    const result = await runCommand(command);

    // ... rest of method unchanged
```

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS — all existing tests still pass (the new parameter is optional everywhere)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/agents/claude.ts src/agents/transcript-agent.ts
git commit -m "feat: thread mcpConfigPath through agent session interface"
```

---

### Task 3: Wire MCP config through runner and prepareTempTaskDir

**Files:**
- Modify: `src/evalRunner.ts:190-250` (runSingleTrial)
- Modify: `src/conversationRunner.ts:33-42,319` (ConversationRunOptions, createAgentSession call)
- Modify: `src/commands/run.ts:315-348` (prepareTempTaskDir)
- Modify: `tests/commands.run.test.ts`

- [ ] **Step 1: Pass `mcpConfigPath` to conversation runner**

In `src/evalRunner.ts`, update the `runConversationTrial` call (around line 194) to pass `mcpConfigPath`:

```typescript
const conversationResult = await runConversationTrial({
    agent,
    conversation: opts.conversation,
    env,
    graderModel: opts.graderModel,
    mcpConfigPath: opts.mcpConfigPath,
    provider: this.provider,
    runtime,
    taskPath,
    timeoutSec: opts.timeoutSec,
    timestamp: () => this.timestamp(),
    agentName: opts.agentName,
});
```

- [ ] **Step 2: Pass `mcpConfigPath` to agent session in instruction path**

In `src/evalRunner.ts`, update the `createAgentSession` call (around line 246) to pass options:

```typescript
import {
    AgentCommandRunner,
    AgentSessionOptions,
    BaseAgent,
    // ... existing imports
} from './types';
```

```typescript
const sessionOptions: AgentSessionOptions | undefined = opts.mcpConfigPath
    ? { mcpConfigPath: opts.mcpConfigPath }
    : undefined;
const session = await createAgentSession(agent, runtime, loggedRunCommand, sessionOptions);
```

- [ ] **Step 3: Update conversationRunner to accept and pass `mcpConfigPath`**

In `src/conversationRunner.ts`, update imports (line 9-21):

```typescript
import {
    BaseAgent,
    CommandExecutionOptions,
    ConversationReplySource,
    EnvironmentHandle,
    EnvironmentProvider,
    GraderResult,
    LogEntry,
    TrialResult,
    TurnCommand,
    AgentSessionOptions,
    createAgentSession,
    getWorkspacePath,
} from './types';
```

Add `mcpConfigPath` to `ConversationRunOptions` (line 33):

```typescript
interface ConversationRunOptions {
    agent: BaseAgent;
    conversation: ResolvedConversation;
    env?: Record<string, string>;
    graderModel?: string;
    mcpConfigPath?: string;
    provider: EnvironmentProvider;
    runtime: EnvironmentHandle;
    taskPath: string;
    timeoutSec: number;
    // ... rest unchanged
```

Update the `createAgentSession` call (around line 319):

```typescript
const sessionOptions: AgentSessionOptions | undefined = opts.mcpConfigPath
    ? { mcpConfigPath: opts.mcpConfigPath }
    : undefined;

const session = await createAgentSession(
    opts.agent,
    opts.runtime,
    async (cmd: string, commandOptions?: CommandExecutionOptions) => {
        // ... existing callback unchanged
    },
    sessionOptions
);
```

- [ ] **Step 4: Copy MCP config in `prepareTempTaskDir`**

In `src/commands/run.ts`, inside `prepareTempTaskDir`, add before the `mcp_mock` block (around line 315, after workspace copy loop):

```typescript
    // Copy MCP config into the task bundle if specified
    if (resolved.mcp_config) {
        const mcpSrc = resolved.mcp_config; // already absolute from resolveTask
        if (await fs.pathExists(mcpSrc)) {
            await fs.copy(mcpSrc, path.join(tmpDir, '.pathgrade-mcp.json'));
        } else {
            throw new Error(`mcp_config not found: ${mcpSrc}`);
        }
    }
```

- [ ] **Step 5: Write tests for `mcp_config` file staging**

In `tests/commands.run.test.ts`, add a new describe block:

```typescript
describe('prepareTempTaskDir mcp_config', () => {
  it('copies mcp_config file into workspace as .pathgrade-mcp.json', async () => {
    const baseDir = path.join(os.tmpdir(), `pathgrade-mcp-config-test-${Date.now()}`);
    const tmpDir = path.join(os.tmpdir(), `pathgrade-mcp-config-out-${Date.now()}`);
    await fsExtra.ensureDir(baseDir);

    // Create a mock MCP config file
    const mcpConfigPath = path.join(baseDir, 'mcp-servers.json');
    await fsExtra.writeJson(mcpConfigPath, {
      mcpServers: {
        'test-server': { command: 'node', args: ['/absolute/path/server.js'] },
      },
    });

    const resolved = {
      type: 'instruction' as const,
      name: 'mcp-config-test',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_config: mcpConfigPath,
    };

    try {
      await prepareTempTaskDir(resolved as any, baseDir, tmpDir);

      const copiedConfig = await fsExtra.readJson(path.join(tmpDir, '.pathgrade-mcp.json'));
      expect(copiedConfig.mcpServers['test-server']).toBeDefined();
      expect(copiedConfig.mcpServers['test-server'].command).toBe('node');
    } finally {
      await fsExtra.remove(baseDir);
      await fsExtra.remove(tmpDir);
    }
  });

  it('throws when mcp_config file does not exist', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-mcp-config-missing-${Date.now()}`);

    const resolved = {
      type: 'instruction' as const,
      name: 'missing-config',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_config: '/nonexistent/path/mcp.json',
    };

    try {
      await expect(prepareTempTaskDir(resolved as any, '/base', tmpDir)).rejects.toThrow(/not found/i);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });

  it('does not create .pathgrade-mcp.json when mcp_config is absent', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-mcp-config-absent-${Date.now()}`);

    const resolved = {
      type: 'instruction' as const,
      name: 'no-config',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);
      expect(await fsExtra.pathExists(path.join(tmpDir, '.pathgrade-mcp.json'))).toBe(false);
    } finally {
      await fsExtra.remove(tmpDir);
    }
  });
});
```

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/evalRunner.ts src/conversationRunner.ts src/commands/run.ts tests/commands.run.test.ts
git commit -m "feat: wire mcp_config through runner and prepare in task dir"
```

---

### Task 4: Add agent-level tests

**Files:**
- Modify: `tests/agents.test.ts`

- [ ] **Step 1: Write tests for ClaudeAgent with `mcpConfigPath`**

In `tests/agents.test.ts`, add to the `ClaudeAgent` describe block:

```typescript
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

  const claudeCmd = commands.find(c => c.includes('claude -p'));
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

  const claudeCmd = commands.find(c => c.includes('claude -p'));
  expect(claudeCmd).not.toContain('--mcp-config');
});
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/agents.test.ts
git commit -m "test: add ClaudeAgent mcp_config flag tests"
```

---

### Task 5: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compiler check**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc -p tsconfig.build.json --noEmit`
Expected: No type errors

- [ ] **Step 3: Commit if any cleanup needed**

```bash
git add -A
git commit -m "feat: complete mcp_config support for eval tasks"
```
