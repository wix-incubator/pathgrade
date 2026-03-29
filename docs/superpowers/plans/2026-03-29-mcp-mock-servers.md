# MCP Mock Servers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow eval authors to declare mock MCP tool responses in their eval config so evals get deterministic, fast, zero-setup MCP tool behavior.

**Architecture:** A `mockMcpServer()` helper returns a descriptor that PathGrade uses to generate fixture JSON files and a normalized `.pathgrade-mcp.json` config at task-prep time. A standalone mock MCP server script (`src/mcp-mock-server.ts`) reads the fixture and responds to MCP stdio protocol calls. The generated config is consumed by the existing agent adapters (Claude via `--mcp-config`, Codex via `codex mcp add`). This plan builds on top of the MCP config support and Codex MCP support plans — both must be merged first.

**Tech Stack:** TypeScript, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/mcp-mock.types.ts` | Create | `MockMcpTool`, `MockMcpServerConfig`, `MockMcpServerDescriptor` types |
| `src/core/mcp-mock.ts` | Create | `mockMcpServer()` helper function |
| `src/mcp-mock-server.ts` | Create | Standalone stdio MCP mock server |
| `src/core/config.types.ts` | Modify | Add `mcp_mock?` to 4 task/defaults interfaces |
| `src/core/config.ts` | Modify | Validate `mcp_mock`, mutual exclusion with `mcp_config` |
| `src/core/define-eval.ts` | Modify | Pass `mcp_mock` through task mapping |
| `src/commands/run.ts` | Modify | Generate fixture + MCP config in `prepareTempTaskDir` |
| `package.json` | Modify | Add `"./mcp-mock"` to exports map |
| `tests/mcp-mock.test.ts` | Create | `mockMcpServer()` helper tests |
| `tests/mcp-mock-server.test.ts` | Create | Mock server protocol tests |
| `tests/config.test.ts` | Modify | Mutual exclusion validation tests |
| `tests/commands.run.test.ts` | Modify | Fixture + config generation tests |

---

### Task 1: Create mock types and helper

**Files:**
- Create: `src/core/mcp-mock.types.ts`
- Create: `src/core/mcp-mock.ts`
- Create: `tests/mcp-mock.test.ts`

- [ ] **Step 1: Write failing test for `mockMcpServer` helper**

Create `tests/mcp-mock.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mockMcpServer } from '../src/core/mcp-mock';

describe('mockMcpServer', () => {
  it('returns a MockMcpServerDescriptor with __type tag', () => {
    const result = mockMcpServer({
      name: 'weather-api',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    expect(result.__type).toBe('mock_mcp_server');
    expect(result.config.name).toBe('weather-api');
    expect(result.config.tools).toHaveLength(1);
    expect(result.config.tools[0].name).toBe('get_weather');
    expect(result.config.tools[0].response).toEqual({ temp: 72 });
  });

  it('preserves optional fields', () => {
    const result = mockMcpServer({
      name: 'db',
      tools: [{
        name: 'query',
        description: 'Run a query',
        when: 'SELECT',
        inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
        response: [{ id: 1 }],
      }],
    });

    expect(result.config.tools[0].description).toBe('Run a query');
    expect(result.config.tools[0].when).toBe('SELECT');
    expect(result.config.tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
    });
  });

  it('validates when patterns as regex at creation time', () => {
    expect(() => mockMcpServer({
      name: 'bad',
      tools: [{ name: 't', when: '(unclosed', response: 'x' }],
    })).toThrow(/regex/i);
  });

  it('throws if tools array is empty', () => {
    expect(() => mockMcpServer({ name: 'empty', tools: [] })).toThrow(/tool/i);
  });

  it('throws if name is empty', () => {
    expect(() => mockMcpServer({ name: '', tools: [{ name: 't', response: 'x' }] })).toThrow(/name/i);
  });

  it('throws if a tool has no name', () => {
    expect(() => mockMcpServer({
      name: 'srv',
      tools: [{ name: '', response: 'x' }],
    })).toThrow(/name/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/mcp-mock.test.ts`
Expected: FAIL — module `../src/core/mcp-mock` does not exist

- [ ] **Step 3: Create the types file**

Create `src/core/mcp-mock.types.ts`:

```typescript
export interface MockMcpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;
    response: unknown;
}

export interface MockMcpServerConfig {
    name: string;
    tools: MockMcpTool[];
}

export interface MockMcpServerDescriptor {
    __type: 'mock_mcp_server';
    config: MockMcpServerConfig;
}
```

- [ ] **Step 4: Create the helper function**

Create `src/core/mcp-mock.ts`:

```typescript
import { MockMcpServerConfig, MockMcpServerDescriptor } from './mcp-mock.types';

export type { MockMcpTool, MockMcpServerConfig, MockMcpServerDescriptor } from './mcp-mock.types';

export function mockMcpServer(config: MockMcpServerConfig): MockMcpServerDescriptor {
    if (!config.name || typeof config.name !== 'string') {
        throw new Error('mockMcpServer: name must be a non-empty string');
    }
    if (!Array.isArray(config.tools) || config.tools.length === 0) {
        throw new Error('mockMcpServer: must have at least one tool');
    }
    for (let i = 0; i < config.tools.length; i++) {
        const tool = config.tools[i];
        if (!tool.name || typeof tool.name !== 'string') {
            throw new Error(`mockMcpServer: tools[${i}].name must be a non-empty string`);
        }
        if (tool.when !== undefined) {
            try {
                new RegExp(tool.when, 'i');
            } catch (e) {
                throw new Error(`mockMcpServer: tools[${i}].when is not a valid regex: ${(e as Error).message}`);
            }
        }
    }
    return { __type: 'mock_mcp_server', config };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/mcp-mock.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/mcp-mock.types.ts src/core/mcp-mock.ts tests/mcp-mock.test.ts
git commit -m "feat: add mockMcpServer helper and types"
```

---

### Task 2: Add `mcp_mock` to config types and threading

**Files:**
- Modify: `src/core/config.types.ts:112-122` (EvalTaskBase)
- Modify: `src/core/config.types.ts:140-147` (EvalDefaults)
- Modify: `src/core/config.types.ts:158-168` (ResolvedTaskBase)
- Modify: `src/core/config.types.ts:192-202` (DefineEvalTaskBase)
- Modify: `src/core/define-eval.ts:18-35`
- Modify: `src/core/config.ts:41-56` (RawTask)
- Modify: `src/core/config.ts:259-288` (validateConfig base)

- [ ] **Step 1: Write failing test for `mcp_mock` passthrough**

In `tests/define-eval.test.ts`, add:

```typescript
import { mockMcpServer } from '../src/core/mcp-mock';

it('passes mcp_mock through on task', () => {
  const mock = mockMcpServer({
    name: 'weather',
    tools: [{ name: 'get_weather', response: { temp: 72 } }],
  });
  const config = defineEval({
    tasks: [{
      name: 'mcp-task',
      type: 'instruction',
      instruction: 'use mcp',
      mcp_mock: mock,
      graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
    }],
  });

  expect((config.tasks[0] as any).mcp_mock).toBe(mock);
});

it('passes mcp_mock through on defaults', () => {
  const mock = mockMcpServer({
    name: 'weather',
    tools: [{ name: 'get_weather', response: { temp: 72 } }],
  });
  const config = defineEval({
    defaults: { mcp_mock: mock },
    tasks: [{
      name: 'mcp-task',
      type: 'instruction',
      instruction: 'use mcp',
      graders: [deterministicGrader({ execute: async () => ({ score: 1 }) })],
    }],
  });

  expect((config.defaults as any).mcp_mock).toBe(mock);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/define-eval.test.ts -t "mcp_mock"`
Expected: FAIL — `mcp_mock` property does not exist on types

- [ ] **Step 3: Add `mcp_mock` to config type interfaces**

In `src/core/config.types.ts`, add the import at the top:

```typescript
import type { MockMcpServerDescriptor } from './mcp-mock.types';
```

Add `mcp_mock?: MockMcpServerDescriptor | MockMcpServerDescriptor[];` to these four interfaces, after the last field in each:

- `EvalTaskBase` (after `environment`, around line 121)
- `EvalDefaults` (after `environment`, around line 146)
- `ResolvedTaskBase` (after `environment`, around line 167)
- `DefineEvalTaskBase` (after `environment`, around line 201)

- [ ] **Step 4: Pass `mcp_mock` through in `defineEval`**

In `src/core/define-eval.ts`, add `mcp_mock: t.mcp_mock` to the `base` object (around line 30, after `environment: t.environment`):

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
    mcp_mock: t.mcp_mock,
};
```

- [ ] **Step 5: Pass `mcp_mock` through in `validateConfig`**

In `src/core/config.ts`, add `mcp_mock?: unknown` to `RawTask` (around line 54, after `docker`):

```typescript
mcp_mock?: unknown;
```

Add `mcp_mock: (config.defaults as any)?.mcp_mock` won't work because defaults spread already includes it. The spread `...(config.defaults || {})` at line 149 naturally includes `mcp_mock`. No change needed for defaults.

Add `mcp_mock: t.mcp_mock` to the `base` object in `validateConfig` (around line 287, after `environment: t.environment`):

```typescript
mcp_mock: t.mcp_mock,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/define-eval.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/config.types.ts src/core/define-eval.ts src/core/config.ts tests/define-eval.test.ts
git commit -m "feat: add mcp_mock field to config types"
```

---

### Task 3: Add validation — mutual exclusion and `mcp_mock` shape

**Files:**
- Modify: `src/core/config.ts:412-476` (resolveTask)
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests for mutual exclusion**

In `tests/config.test.ts`, add to the `resolveTask` describe block:

```typescript
import { mockMcpServer } from '../src/core/mcp-mock';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/config.test.ts -t "mcp_mock"`
Expected: FAIL

- [ ] **Step 3: Add mutual exclusion and passthrough in `resolveTask`**

In `src/core/config.ts`, inside `resolveTask` (around line 425, after `grader_model` resolution):

```typescript
import type { MockMcpServerDescriptor } from './mcp-mock.types';
```

```typescript
// Resolve mcp_mock: task overrides defaults (no merging)
const mcp_mock: MockMcpServerDescriptor | MockMcpServerDescriptor[] | undefined =
    task.mcp_mock !== undefined ? task.mcp_mock : (defaults as any).mcp_mock;

// Resolve mcp_config (from dependency plan — already present after MCP config plan merge)
const mcp_config_raw = task.mcp_config || (defaults as any).mcp_config;
const mcp_config = mcp_config_raw ? path.resolve(baseDir, mcp_config_raw) : undefined;

// Mutual exclusion
if (mcp_config && mcp_mock) {
    throw new Error(`Task "${task.name}": mcp_config and mcp_mock are mutually exclusive`);
}
```

Then add `mcp_mock` and `mcp_config` to both return objects (conversation and instruction), after `environment`:

```typescript
mcp_config,
mcp_mock,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "feat: validate mcp_mock and mutual exclusion with mcp_config"
```

---

### Task 4: Build the mock MCP server

**Files:**
- Create: `src/mcp-mock-server.ts`
- Create: `tests/mcp-mock-server.test.ts`

- [ ] **Step 1: Write failing test for the mock server**

Create `tests/mcp-mock-server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

const tempDirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs) { try { p.kill(); } catch {} }
  procs.length = 0;
  for (const d of tempDirs) { try { await fs.remove(d); } catch {} }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `pathgrade-mock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(dir: string, fixture: unknown): Promise<string> {
  await fs.ensureDir(dir);
  const fixturePath = path.join(dir, 'fixture.json');
  await fs.writeJson(fixturePath, fixture);
  return fixturePath;
}

function sendJsonRpc(proc: ChildProcess, method: string, params: unknown = {}, id: number = 1): void {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  proc.stdin!.write(body + '\n');
}

function sendNotification(proc: ChildProcess, method: string, params: unknown = {}): void {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  proc.stdin!.write(body + '\n');
}

async function readResponse(proc: ChildProcess, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for response')), timeoutMs);
    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {}
      }
    };
    proc.stdout!.on('data', onData);
  });
}

function spawnMockServer(fixturePath: string): ChildProcess {
  const serverPath = path.resolve(__dirname, '../src/mcp-mock-server.ts');
  const proc = spawn('npx', ['tsx', serverPath, fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(proc);
  return proc;
}

describe('mcp-mock-server', () => {
  it('responds to initialize with capabilities', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'greet', response: 'hello' }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    const response = await readResponse(proc);

    expect(response.result).toBeDefined();
    expect(response.result.capabilities).toBeDefined();
    expect(response.result.capabilities.tools).toBeDefined();
  });

  it('lists tools from fixture', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [
        { name: 'get_weather', description: 'Get weather', response: { temp: 72 } },
        { name: 'get_time', response: '12:00' },
      ],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/list', {}, 2);
    const response = await readResponse(proc);

    expect(response.result.tools).toHaveLength(2);
    expect(response.result.tools[0].name).toBe('get_weather');
    expect(response.result.tools[0].description).toBe('Get weather');
    expect(response.result.tools[1].name).toBe('get_time');
    expect(response.result.tools[1].inputSchema).toEqual({ type: 'object' });
  });

  it('calls tool and returns response', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'get_weather', response: { temp: 72, conditions: 'sunny' } }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/call', { name: 'get_weather', arguments: { city: 'NYC' } }, 2);
    const response = await readResponse(proc);

    expect(response.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ temp: 72, conditions: 'sunny' }) },
    ]);
  });

  it('matches when pattern against input', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [
        { name: 'read_file', when: 'config\\.json', response: '{"key":"val"}' },
        { name: 'read_file', when: 'package\\.json', response: '{"name":"app"}' },
        { name: 'read_file', response: 'not found' },
      ],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');

    sendJsonRpc(proc, 'tools/call', { name: 'read_file', arguments: { path: 'config.json' } }, 2);
    const r1 = await readResponse(proc);
    expect(r1.result.content[0].text).toBe('{"key":"val"}');

    sendJsonRpc(proc, 'tools/call', { name: 'read_file', arguments: { path: 'unknown.txt' } }, 3);
    const r2 = await readResponse(proc);
    expect(r2.result.content[0].text).toBe('not found');
  });

  it('returns error for unknown tool', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'greet', response: 'hello' }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/call', { name: 'nonexistent', arguments: {} }, 2);
    const response = await readResponse(proc);

    expect(response.result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/mcp-mock-server.test.ts`
Expected: FAIL — `src/mcp-mock-server.ts` does not exist

- [ ] **Step 3: Implement the mock MCP server**

Create `src/mcp-mock-server.ts`:

```typescript
import * as fs from 'fs';
import * as readline from 'readline';

interface FixtureTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;
    response: unknown;
}

interface Fixture {
    name: string;
    tools: FixtureTool[];
}

function loadFixture(fixturePath: string): Fixture {
    const content = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(content);
}

function buildToolSchemas(fixture: Fixture): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const seen = new Set<string>();
    const schemas: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const tool of fixture.tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        schemas.push({
            name: tool.name,
            description: tool.description || `Mock tool: ${tool.name}`,
            inputSchema: tool.inputSchema || { type: 'object' },
        });
    }
    return schemas;
}

function matchTool(fixture: Fixture, toolName: string, args: unknown): { response: unknown } | null {
    const inputStr = JSON.stringify(args);
    let fallback: FixtureTool | undefined;

    for (const entry of fixture.tools) {
        if (entry.name !== toolName) continue;
        if (entry.when) {
            if (new RegExp(entry.when, 'i').test(inputStr)) {
                return { response: entry.response };
            }
        } else if (!fallback) {
            fallback = entry;
        }
    }

    if (fallback) return { response: fallback.response };
    return null;
}

function formatResponse(response: unknown): string {
    return typeof response === 'string' ? response : JSON.stringify(response);
}

function sendResponse(id: number | string, result: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(msg + '\n');
}

function sendError(id: number | string, code: number, message: string): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    process.stdout.write(msg + '\n');
}

function main() {
    const fixturePath = process.argv[2];
    if (!fixturePath) {
        process.stderr.write('Usage: mcp-mock-server <fixture.json>\n');
        process.exit(1);
    }

    let fixture: Fixture;
    try {
        fixture = loadFixture(fixturePath);
    } catch (e) {
        process.stderr.write(`Failed to load fixture: ${(e as Error).message}\n`);
        process.exit(1);
    }

    const toolSchemas = buildToolSchemas(fixture);

    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => {
        if (!line.trim()) return;

        let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: any };
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        // Notifications (no id) — acknowledge silently
        if (msg.id === undefined) return;

        switch (msg.method) {
            case 'initialize':
                sendResponse(msg.id, {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: fixture.name, version: '1.0.0' },
                });
                break;

            case 'tools/list':
                sendResponse(msg.id, { tools: toolSchemas });
                break;

            case 'tools/call': {
                const toolName = msg.params?.name;
                const toolArgs = msg.params?.arguments ?? {};
                const match = matchTool(fixture, toolName, toolArgs);
                if (match) {
                    sendResponse(msg.id, {
                        content: [{ type: 'text', text: formatResponse(match.response) }],
                    });
                } else {
                    sendResponse(msg.id, {
                        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
                        isError: true,
                    });
                }
                break;
            }

            case 'ping':
                sendResponse(msg.id, {});
                break;

            default:
                sendError(msg.id, -32601, `Method not found: ${msg.method}`);
                break;
        }
    });

    rl.on('close', () => process.exit(0));
}

main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/mcp-mock-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-mock-server.ts tests/mcp-mock-server.test.ts
git commit -m "feat: implement standalone mock MCP server"
```

---

### Task 5: Generate fixture and MCP config in `prepareTempTaskDir`

**Files:**
- Modify: `src/commands/run.ts:265-314` (prepareTempTaskDir)
- Modify: `tests/commands.run.test.ts`

- [ ] **Step 1: Write failing test for fixture generation**

In `tests/commands.run.test.ts`, add:

```typescript
import { mockMcpServer } from '../src/core/mcp-mock';
import { MockMcpServerDescriptor } from '../src/core/mcp-mock.types';

describe('prepareTempTaskDir mcp_mock', () => {
  it('generates fixture and MCP config for mcp_mock', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const mock = mockMcpServer({
      name: 'weather-api',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    const resolved = {
      type: 'instruction' as const,
      name: 'mock-test',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_mock: mock,
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);

      // Check fixture file
      const fixturePath = path.join(tmpDir, '.pathgrade-mcp-mock-weather-api.json');
      expect(await fs.pathExists(fixturePath)).toBe(true);
      const fixture = await fs.readJson(fixturePath);
      expect(fixture.name).toBe('weather-api');
      expect(fixture.tools[0].name).toBe('get_weather');

      // Check MCP config
      const mcpConfig = await fs.readJson(path.join(tmpDir, '.pathgrade-mcp.json'));
      expect(mcpConfig.mcpServers['weather-api']).toBeDefined();
      expect(mcpConfig.mcpServers['weather-api'].command).toBe('node');
      expect(mcpConfig.mcpServers['weather-api'].args).toHaveLength(2);
      // First arg: absolute path to mock server script
      expect(path.isAbsolute(mcpConfig.mcpServers['weather-api'].args[0])).toBe(true);
      // Second arg: absolute path to fixture
      expect(path.isAbsolute(mcpConfig.mcpServers['weather-api'].args[1])).toBe(true);
    } finally {
      await fs.remove(tmpDir);
    }
  });

  it('generates multiple fixtures for array mcp_mock', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const mocks: MockMcpServerDescriptor[] = [
      mockMcpServer({ name: 'weather', tools: [{ name: 'get_weather', response: 72 }] }),
      mockMcpServer({ name: 'user-db', tools: [{ name: 'get_user', response: { id: 1 } }] }),
    ];

    const resolved = {
      type: 'instruction' as const,
      name: 'multi-mock',
      instruction: 'test',
      workspace: [],
      graders: [],
      agent: 'claude' as const,
      trials: 1,
      timeout: 60,
      environment: { cpus: 2, memory_mb: 2048 },
      mcp_mock: mocks,
    };

    try {
      await prepareTempTaskDir(resolved as any, '/base', tmpDir);

      const mcpConfig = await fs.readJson(path.join(tmpDir, '.pathgrade-mcp.json'));
      expect(Object.keys(mcpConfig.mcpServers)).toEqual(['weather', 'user-db']);
    } finally {
      await fs.remove(tmpDir);
    }
  });

  it('does not generate MCP config when mcp_mock is absent', async () => {
    const tmpDir = path.join(os.tmpdir(), `pathgrade-run-test-${Date.now()}`);
    const resolved = {
      type: 'instruction' as const,
      name: 'no-mock',
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
      expect(await fs.pathExists(path.join(tmpDir, '.pathgrade-mcp.json'))).toBe(false);
    } finally {
      await fs.remove(tmpDir);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/commands.run.test.ts -t "mcp_mock"`
Expected: FAIL — `prepareTempTaskDir` doesn't handle `mcp_mock`

- [ ] **Step 3: Add fixture + config generation to `prepareTempTaskDir`**

In `src/commands/run.ts`, add the import at the top:

```typescript
import type { MockMcpServerDescriptor } from '../core/mcp-mock.types';
```

At the end of `prepareTempTaskDir`, before the closing brace (after the workspace file copy loop, around line 313):

```typescript
    // Generate mock MCP server fixtures and config
    const mcp_mock = (resolved as any).mcp_mock as MockMcpServerDescriptor | MockMcpServerDescriptor[] | undefined;
    if (mcp_mock) {
        const mocks = Array.isArray(mcp_mock) ? mcp_mock : [mcp_mock];
        const mcpServers: Record<string, { command: string; args: string[] }> = {};

        for (const mock of mocks) {
            const sanitizedName = mock.config.name.replace(/[^a-zA-Z0-9-]/g, '-');
            const fixturePath = path.join(tmpDir, `.pathgrade-mcp-mock-${sanitizedName}.json`);
            await fs.writeJson(fixturePath, mock.config, { spaces: 2 });

            const mockServerScript = path.resolve(__dirname, '../mcp-mock-server.js');
            mcpServers[mock.config.name] = {
                command: 'node',
                args: [mockServerScript, fixturePath],
            };
        }

        await fs.writeJson(path.join(tmpDir, '.pathgrade-mcp.json'), { mcpServers }, { spaces: 2 });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/commands.run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts tests/commands.run.test.ts
git commit -m "feat: generate mock MCP fixtures and config in prepareTempTaskDir"
```

---

### Task 6: Wire `mcpConfigPath` for mock tasks and add package exports

**Files:**
- Modify: `src/commands/run.ts:139-161` (evalOpts construction)
- Modify: `package.json:7-16` (exports)

- [ ] **Step 1: Update `evalOpts` to set `mcpConfigPath` when `mcp_mock` is present**

In `src/commands/run.ts`, update both the conversation and instruction branches of `evalOpts` construction (around lines 140-161). Change:

```typescript
// For conversation branch (around line 149):
mcpConfigPath: resolved.mcp_config ? '.pathgrade-mcp.json' : undefined,
```

To:

```typescript
mcpConfigPath: (resolved.mcp_config || (resolved as any).mcp_mock) ? '.pathgrade-mcp.json' : undefined,
```

Apply the same change to the instruction branch (around line 159).

- [ ] **Step 2: Add `./mcp-mock` to `package.json` exports**

In `package.json`, add the new export after the `"./config"` entry:

```json
"./mcp-mock": {
  "types": "./dist/core/mcp-mock.d.ts",
  "default": "./dist/core/mcp-mock.js"
}
```

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: PASS

- [ ] **Step 4: Run TypeScript compiler check**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts package.json
git commit -m "feat: wire mcpConfigPath for mock tasks and add package export"
```

---

### Task 7: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/nadavlac/projects/pathgrade && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compiler check**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify the mock server compiles**

Run: `cd /Users/nadavlac/projects/pathgrade && npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors — confirms `src/mcp-mock-server.ts` will be included in build output

- [ ] **Step 4: Commit if any cleanup needed**

```bash
git add -A
git commit -m "feat: complete mcp mock server support"
```
