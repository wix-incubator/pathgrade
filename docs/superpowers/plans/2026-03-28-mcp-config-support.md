# MCP Config Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow eval tasks to specify an MCP server config file so the Claude agent can use MCP tools during evaluation runs.

**Architecture:** Add an optional `mcp_config` field at both task and defaults level. During task resolution, the path is resolved relative to the eval file directory. At runtime, the MCP config file is copied into the trial workspace and the Claude CLI command is extended with `--mcp-config`. Other agents (Gemini, Codex) ignore it since they don't support MCP yet.

**Tech Stack:** TypeScript, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/config.types.ts` | Modify | Add `mcp_config?: string` to 4 interfaces |
| `src/core/define-eval.ts` | Modify | Pass `mcp_config` through task mapping |
| `src/core/config.ts` | Modify | Pass through in validation, resolve path in `resolveTask` |
| `src/evalRunner.ts` | Modify | Add `mcpConfigPath?: string` to `EvalRunOptions` |
| `src/types.ts` | Modify | Add `AgentSessionOptions` interface, update `BaseAgent.createSession` and `createAgentSession` |
| `src/agents/claude.ts` | Modify | Accept options, append `--mcp-config` flag |
| `src/agents/transcript-agent.ts` | Modify | Accept and ignore options (forward-compat) |
| `src/conversationRunner.ts` | Modify | Pass `mcpConfigPath` to `createAgentSession` |
| `src/commands/run.ts` | Modify | Set `mcpConfigPath` in opts, copy file in `prepareTempTaskDir` |
| `tests/define-eval.test.ts` | Modify | Add mcp_config test cases |
| `tests/config.test.ts` | Modify | Add mcp_config resolution tests |

---

### Task 1: Add `mcp_config` to config types

**Files:**
- Modify: `src/core/config.types.ts:110-120` (EvalTaskBase)
- Modify: `src/core/config.types.ts:137-145` (EvalDefaults)
- Modify: `src/core/config.types.ts:155-167` (ResolvedTaskBase)
- Modify: `src/core/config.types.ts:189-200` (DefineEvalTaskBase)

- [ ] **Step 1: Write failing test for mcp_config in defineEval**

In `tests/define-eval.test.ts`, add after the `tool_usage` test:

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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/define-eval.test.ts`
Expected: FAIL — `mcp_config` doesn't exist on the types

- [ ] **Step 3: Add `mcp_config` to config type interfaces**

In `src/core/config.types.ts`, add `mcp_config?: string` to these four interfaces:

`EvalTaskBase` (after `environment` field around line 119):
```typescript
interface EvalTaskBase {
    name: string;
    workspace?: WorkspaceEntry[];
    graders: GraderDescriptor[];
    solution?: string;
    agent?: AgentName;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
    mcp_config?: string;
}
```

`EvalDefaults` (after `environment` field around line 145):
```typescript
export interface EvalDefaults {
    agent: AgentName;
    trials: number;
    timeout: number;
    threshold: number;
    grader_model?: string;
    environment: EnvironmentConfig;
    mcp_config?: string;
}
```

`ResolvedTaskBase` (after `environment` field around line 166):
```typescript
interface ResolvedTaskBase {
    name: string;
    workspace: WorkspaceMapping[];
    graders: GraderDescriptor[];
    solution?: string;
    agent: AgentName;
    trials: number;
    timeout: number;
    grader_model?: string;
    environment: EnvironmentConfig;
    mcp_config?: string;
}
```

`DefineEvalTaskBase` (after `environment` field around line 199):
```typescript
interface DefineEvalTaskBase {
    name: string;
    workspace?: (string | WorkspaceMapping | WorkspaceDirectoryMapping)[];
    graders: GraderDescriptor[];
    solution?: string;
    agent?: AgentName;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
    mcp_config?: string;
}
```

- [ ] **Step 4: Pass `mcp_config` through in `defineEval`**

In `src/core/define-eval.ts`, add `mcp_config: t.mcp_config` to the `base` object (around line 20):

```typescript
const base = {
    name: t.name,
    workspace: t.workspace,
    graders: t.graders,
    solution: t.solution,
    agent: t.agent,
    trials: t.trials,
    timeout: t.timeout,
    grader_model: t.grader_model,
    environment: t.environment,
    mcp_config: t.mcp_config,
};
```

- [ ] **Step 5: Pass `mcp_config` through in `validateConfig`**

In `src/core/config.ts`, add `mcp_config: t.mcp_config` to the `base` object inside the `config.tasks.map` (around line 239):

```typescript
const base = {
    name: t.name,
    workspace,
    graders: (t.graders || []).map(/* existing code */),
    solution: t.solution,
    agent: t.agent,
    trials: t.trials,
    timeout: t.timeout,
    grader_model: t.grader_model,
    environment: t.environment,
    mcp_config: t.mcp_config,
};
```

Also add `mcp_config?: string` to the `RawTask` interface (around line 41):

```typescript
interface RawTask {
    name?: string;
    type?: string;
    instruction?: string;
    conversation?: RawConversation;
    workspace?: (string | { src?: string; dest?: string; dir?: string; chmod?: string })[];
    graders?: any[];
    solution?: string;
    agent?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
    mcp_config?: string;
    provider?: unknown;
    docker?: unknown;
}
```

And add `mcp_config?: string` to the `RawEvalConfig.defaults` type (around line 26):

```typescript
interface RawEvalConfig {
    version?: string;
    skillPath?: string;
    defaults?: Record<string, unknown> & {
        provider?: unknown;
        docker?: unknown;
        agent?: string;
        trials?: number;
        timeout?: number;
        threshold?: number;
        grader_model?: string;
        environment?: Partial<EnvironmentConfig>;
        mcp_config?: string;
    };
    tasks?: RawTask[];
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/define-eval.test.ts`
Expected: PASS — all tests including the two new ones

- [ ] **Step 7: Commit**

```bash
git add src/core/config.types.ts src/core/define-eval.ts src/core/config.ts tests/define-eval.test.ts
git commit -m "feat: add mcp_config field to eval config types"
```

---

### Task 2: Resolve `mcp_config` in `resolveTask`

**Files:**
- Modify: `src/core/config.ts:388-452` (resolveTask function)
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test for mcp_config resolution**

In `tests/config.test.ts`, add to the `resolveTask` describe block:

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

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/config.test.ts -t "mcp_config"`
Expected: FAIL — `mcp_config` not set on resolved task

- [ ] **Step 3: Add mcp_config resolution to `resolveTask`**

In `src/core/config.ts`, inside `resolveTask` (around line 401, after `grader_model` resolution):

```typescript
const mcp_config_raw = task.mcp_config || defaults.mcp_config;
const mcp_config = mcp_config_raw
    ? path.resolve(baseDir, mcp_config_raw)
    : undefined;

// Fail fast if the file doesn't exist
if (mcp_config && !(await fs.pathExists(mcp_config))) {
    throw new Error(`mcp_config not found: ${mcp_config} (task "${task.name}")`);
}
```

Then add `mcp_config` to both return objects. In the conversation return (around line 425):

```typescript
if (task.type === 'conversation') {
    return {
        type: 'conversation' as const,
        name: task.name,
        conversation: conversation!,
        workspace,
        graders,
        solution,
        agent,
        trials,
        timeout,
        grader_model,
        environment,
        mcp_config,
    };
}
```

And in the instruction return (around line 439):

```typescript
return {
    type: 'instruction' as const,
    name: task.name,
    instruction: instruction!,
    workspace,
    graders,
    solution,
    agent,
    trials,
    timeout,
    grader_model,
    environment,
    mcp_config,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "feat: resolve mcp_config path in resolveTask"
```

---

### Task 3: Thread MCP config through the agent interface

**Files:**
- Modify: `src/types.ts:140-200`
- Modify: `src/agents/claude.ts`
- Modify: `src/agents/transcript-agent.ts`
- Modify: `src/conversationRunner.ts:335`

- [ ] **Step 1: Add `AgentSessionOptions` to types.ts**

In `src/types.ts`, add the new interface before `BaseAgent` (around line 172):

```typescript
export interface AgentSessionOptions {
    mcpConfigPath?: string;
}
```

Update `BaseAgent.createSession` to accept the options parameter:

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

Update `createAgentSession` to pass options through:

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

In `src/agents/transcript-agent.ts`, update the `createSession` signature to accept and ignore the options:

```typescript
async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, _options?: AgentSessionOptions): Promise<AgentSession> {
```

Add the import at the top:

```typescript
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';
```

- [ ] **Step 3: Update ClaudeAgent to use `mcpConfigPath`**

In `src/agents/claude.ts`, update `createSession` to accept options and pass `mcpConfigPath` to `runTurn`:

```typescript
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';
```

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

Update `run` method to accept optional mcpConfigPath:

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

Update `runTurn` to accept and use `mcpConfigPath`:

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

    // ... rest unchanged
```

- [ ] **Step 4: Update conversationRunner to pass options**

In `src/conversationRunner.ts`, update the `createAgentSession` call (around line 335) to pass options:

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

Add `mcpConfigPath` to `ConversationRunOptions`:

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
    timestamp: () => string;
    agentName?: import('./core/config.types').AgentName;
}
```

Update the `createAgentSession` call:

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

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS — all existing tests still pass (the new parameter is optional everywhere)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/agents/claude.ts src/agents/transcript-agent.ts src/conversationRunner.ts
git commit -m "feat: thread mcpConfigPath through agent session interface"
```

---

### Task 4: Wire MCP config in the run command

**Files:**
- Modify: `src/evalRunner.ts:46-60`
- Modify: `src/evalRunner.ts:165-270` (runSingleTrial)
- Modify: `src/commands/run.ts:115-155` (evalOpts construction)
- Modify: `src/commands/run.ts:248-297` (prepareTempTaskDir)

- [ ] **Step 1: Add `mcpConfigPath` to `EvalRunOptions`**

In `src/evalRunner.ts`, add to the `EvalRunOptions` interface (around line 58):

```typescript
export interface EvalRunOptions {
    instruction?: string;
    conversation?: ResolvedConversation;
    graders: GraderDescriptor[];
    timeoutSec: number;
    graderModel?: string;
    graderTimeoutSec?: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    authMode?: 'host' | 'isolated';
    agentName?: import('./core/config.types').AgentName;
    mcpConfigPath?: string;
}
```

- [ ] **Step 2: Pass `mcpConfigPath` to agent session in `runSingleTrial`**

In `src/evalRunner.ts`, inside `runSingleTrial`, update the `createAgentSession` call (around line 245). Add the import:

```typescript
import {
    AgentCommandRunner,
    AgentSessionOptions,
    BaseAgent,
    // ... existing imports
} from './types';
```

Update the call:

```typescript
const sessionOptions: AgentSessionOptions | undefined = opts.mcpConfigPath
    ? { mcpConfigPath: opts.mcpConfigPath }
    : undefined;
const session = await createAgentSession(agent, runtime, loggedRunCommand, sessionOptions);
```

- [ ] **Step 3: Pass `mcpConfigPath` to conversation runner**

In `src/evalRunner.ts`, inside `runSingleTrial`, update the `runConversationTrial` call (around line 193) to pass `mcpConfigPath`:

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

- [ ] **Step 4: Copy MCP config in `prepareTempTaskDir`**

In `src/commands/run.ts`, update `prepareTempTaskDir` to accept and copy the MCP config. Update the function signature:

```typescript
export async function prepareTempTaskDir(
    resolved: ResolvedTask,
    baseDir: string,
    tmpDir: string
) {
```

Add at the end of the function, before the closing brace (after the workspace file copy loop):

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

- [ ] **Step 5: Set `mcpConfigPath` in EvalRunOptions**

In `src/commands/run.ts`, inside `runEvals`, when building `evalOpts` (around line 128-154), add `mcpConfigPath` to both the conversation and instruction branches:

For the conversation branch:
```typescript
if (resolved.type === 'conversation') {
    evalOpts = {
        instruction: undefined,
        conversation: resolved.conversation,
        graders: filteredGraders,
        timeoutSec: resolved.conversation.completion.timeout ?? resolved.timeout,
        graderModel: resolved.grader_model,
        environment: resolved.environment,
        authMode: useHostAuth ? 'host' : undefined,
        agentName,
        mcpConfigPath: resolved.mcp_config ? '.pathgrade-mcp.json' : undefined,
    };
}
```

For the instruction branch:
```typescript
else {
    evalOpts = {
        instruction: resolved.instruction,
        graders: filteredGraders,
        timeoutSec: resolved.timeout,
        graderModel: resolved.grader_model,
        environment: resolved.environment,
        authMode: useHostAuth ? 'host' : undefined,
        agentName,
        mcpConfigPath: resolved.mcp_config ? '.pathgrade-mcp.json' : undefined,
    };
}
```

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/evalRunner.ts src/commands/run.ts
git commit -m "feat: wire mcp_config through runner and prepare in task dir"
```

---

### Task 5: Add agent-level tests

**Files:**
- Modify: `tests/agents.test.ts`

- [ ] **Step 1: Read existing agent tests**

Read `tests/agents.test.ts` to understand the test patterns used.

- [ ] **Step 2: Write test for ClaudeAgent with mcpConfigPath**

Add a test that verifies the Claude agent includes `--mcp-config` in the command when `mcpConfigPath` is provided. The test should use the existing mock pattern from the file:

```typescript
it('includes --mcp-config flag when mcpConfigPath is provided', async () => {
  const agent = new ClaudeAgent();
  const commands: string[] = [];
  const mockRunCommand: AgentCommandRunner = async (cmd) => {
    commands.push(cmd);
    if (cmd.includes('base64')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
      stderr: '',
      exitCode: 0,
    };
  };

  const session = await agent.createSession('workspace', mockRunCommand, { mcpConfigPath: '.pathgrade-mcp.json' });
  await session.start({ message: 'test' });

  const claudeCmd = commands.find(c => c.includes('claude -p'));
  expect(claudeCmd).toContain('--mcp-config .pathgrade-mcp.json');
});

it('omits --mcp-config flag when mcpConfigPath is not provided', async () => {
  const agent = new ClaudeAgent();
  const commands: string[] = [];
  const mockRunCommand: AgentCommandRunner = async (cmd) => {
    commands.push(cmd);
    if (cmd.includes('base64')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({ type: 'result', result: 'done', session_id: 'test-session' }),
      stderr: '',
      exitCode: 0,
    };
  };

  const session = await agent.createSession('workspace', mockRunCommand);
  await session.start({ message: 'test' });

  const claudeCmd = commands.find(c => c.includes('claude -p'));
  expect(claudeCmd).not.toContain('--mcp-config');
});
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/agents.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agents.test.ts
git commit -m "test: add ClaudeAgent mcp_config flag tests"
```

---

### Task 6: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compiler check**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify with a dry-run example**

Create a temporary test to verify the full pipeline compiles correctly:

```typescript
// Quick manual verification — not committed
import { defineEval } from './src/core/define-eval';
import { deterministicGrader } from './src/core/grader-factories';

const config = defineEval({
  defaults: { mcp_config: './mcp-servers.json' },
  tasks: [{
    name: 'mcp-test',
    type: 'instruction',
    instruction: 'Use MCP tools to check the weather',
    mcp_config: './task-mcp.json',
    graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
  }],
});

console.log('mcp_config on defaults:', config.defaults.mcp_config);
console.log('mcp_config on task:', config.tasks[0].mcp_config);
```

- [ ] **Step 4: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "feat: complete mcp_config support for eval tasks"
```
