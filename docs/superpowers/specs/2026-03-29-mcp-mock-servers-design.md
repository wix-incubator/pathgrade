# MCP Mock Servers for Eval Tasks

**Date:** 2026-03-29
**Status:** Draft
**Depends on:** [MCP Config Support Plan](../plans/2026-03-28-mcp-config-support.md), [Codex MCP Support Patch](../plans/2026-03-29-codex-mcp-support-patch.md)

## Problem

Evals that test MCP tool usage require real MCP servers to be running. This creates three issues:

1. **Non-deterministic grading.** Real services return different data across runs, making grader scores unreliable.
2. **Setup friction.** Eval authors must stand up real MCP servers locally before iterating on an eval.
3. **Cost and speed.** Real MCP servers may be slow, rate-limited, or require API keys.

## Design

PathGrade ships a built-in mock MCP server and helper functions. Eval authors declare tool mocks in their eval config. PathGrade generates the MCP config and fixture files automatically. The normalized `.pathgrade-mcp.json` artifact is consumed by agent-specific adapters — Claude via `--mcp-config`, Codex via `codex mcp add` bootstrap. No ports, no process management, no cleanup.

### Eval Author API

**Basic usage:**

```ts
import { defineEval } from 'pathgrade';
import { mockMcpServer } from 'pathgrade/mcp-mock';

export default defineEval({
  tasks: [{
    name: 'weather-assistant',
    type: 'instruction',
    instruction: 'Check the weather in NYC and summarize it.',
    mcp_mock: mockMcpServer({
      name: 'weather-api',
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather for a city',
          response: { temp: 72, conditions: 'sunny', city: 'New York' },
        },
      ],
    }),
    graders: [/* ... */],
  }],
});
```

**Multiple mock servers:**

```ts
mcp_mock: [
  mockMcpServer({
    name: 'weather-api',
    tools: [{ name: 'get_weather', response: { temp: 72 } }],
  }),
  mockMcpServer({
    name: 'user-db',
    tools: [{ name: 'get_user', response: { id: 1, name: 'Alice' } }],
  }),
],
```

**Input-dependent responses:**

```ts
tools: [
  { name: 'read_file', when: 'config\\.json', response: '{"key": "val"}' },
  { name: 'read_file', when: 'package\\.json', response: '{"name": "app"}' },
  { name: 'read_file', response: 'file not found' },  // fallback, no when
]
```

Matching: entries with `when` are checked first (in array order, regex against `JSON.stringify(input)`), then the first entry without `when` is the fallback. Unknown tools return an MCP error.

**Eval-level defaults:**

```ts
export default defineEval({
  defaults: {
    mcp_mock: mockMcpServer({
      name: 'weather-api',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    }),
  },
  tasks: [
    { name: 'task-a', /* inherits weather-api mock */ },
    { name: 'task-b', mcp_mock: /* override with different mock */ },
  ],
});
```

Both `mcp_config` (real) and `mcp_mock` follow the same `defaults + per-task override` pattern. Task-level `mcp_mock` completely replaces defaults `mcp_mock` (no array merging). They are mutually exclusive per-task after defaults are merged.

**Optional input schema override:**

```ts
{
  name: 'get_weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  response: { temp: 72 },
}
```

When omitted, the mock server advertises `{ type: 'object' }` (accepts anything).

### Types

```ts
// src/core/mcp-mock.types.ts

export interface MockMcpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;              // regex matched against JSON.stringify(input)
    response: unknown;          // returned as tool result
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

Config types update — add to task and defaults interfaces in `config.types.ts`:

```ts
mcp_mock?: MockMcpServerDescriptor | MockMcpServerDescriptor[];
```

### Validation

- `mcp_config` and `mcp_mock` are mutually exclusive — error if both set on a resolved task.
- `mcp_mock` must have at least one server with at least one tool.
- Each tool must have a `name` (non-empty string) and a `response`.
- `when` patterns are validated as regex at config load time (same approach as conversation reactions).
- Server names must be non-empty and unique within a task's `mcp_mock` array.

### Mock MCP Server

PathGrade ships `src/mcp-mock-server.ts` — a standalone Node script that:

1. Reads a JSON fixture file path from `process.argv[2]`
2. Implements MCP stdio protocol (JSON-RPC over stdin/stdout)
3. Responds to `initialize` with server capabilities
4. Responds to `tools/list` with tool schemas (auto-generated or explicit)
5. Responds to `tools/call` with matched response

**Matching logic:**

```
for each entry where entry.name === called_tool_name:
    if entry.when exists and RegExp(entry.when, 'i').test(JSON.stringify(input)):
        return entry.response
    if entry.when does not exist:
        fallback = entry  (first no-when entry for this tool name)

if fallback: return fallback.response
else: return MCP error "Unknown tool: <name>"
```

All `when` patterns are case-insensitive.

**Fixture JSON format** (generated by PathGrade, not user-authored):

```json
{
  "name": "weather-api",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather",
      "response": { "temp": 72, "conditions": "sunny" }
    },
    {
      "name": "read_file",
      "when": "config\\.json",
      "response": "{\"key\": \"value\"}"
    },
    {
      "name": "read_file",
      "response": "file not found"
    }
  ]
}
```

### Runtime Lifecycle

All handled in `prepareTempTaskDir`:

**Step 1 — Write fixture files.** For each `MockMcpServerDescriptor`, serialize its config to JSON:

```
.pathgrade-mcp-mock-weather-api.json
.pathgrade-mcp-mock-user-db.json
```

Server names are sanitized to alphanumeric + hyphens.

**Step 2 — Generate MCP config.** Write `.pathgrade-mcp.json` pointing at PathGrade's mock server script via stdio:

```json
{
  "mcpServers": {
    "weather-api": {
      "command": "node",
      "args": [
        "/absolute/path/to/pathgrade/dist/mcp-mock-server.js",
        ".pathgrade-mcp-mock-weather-api.json"
      ]
    }
  }
}
```

The mock server script path is resolved via `path.resolve(__dirname, '../mcp-mock-server.js')`. The fixture path is written as an absolute path (resolved to `tmpDir` at generation time) so that it works regardless of the MCP server subprocess's CWD.

**Step 3 — Set `mcpConfigPath`.** Same as the `mcp_config` flow: `mcpConfigPath: '.pathgrade-mcp.json'` in `EvalRunOptions`. Downstream runners are reused; the agent-specific adapter decides how to consume the config.

**No explicit process management.** The agent runtime spawns and kills MCP server subprocesses. Claude does this natively via `--mcp-config`; Codex registers servers with `codex mcp add` and its runtime manages the lifecycle. PathGrade only provides the config file.

### End-to-End Flow

**Real MCP (`mcp_config`):**

```
User authors mcp-servers.json
  → resolveTask() resolves to absolute path
  → prepareTempTaskDir() copies file as .pathgrade-mcp.json
  → LocalProvider.setup() copies task bundle to workspace
  → Claude: claude --mcp-config ".pathgrade-mcp.json"
  → Codex: bootstrap adapter reads .pathgrade-mcp.json, runs codex mcp add per server
```

**Mock MCP (`mcp_mock`):**

```
User writes mockMcpServer({ name, tools })
  → resolveTask() passes MockMcpServerDescriptor through
  → prepareTempTaskDir() generates fixture JSON + .pathgrade-mcp.json
  → LocalProvider.setup() copies task bundle to workspace
  → Claude: claude --mcp-config ".pathgrade-mcp.json"
  → Codex: bootstrap adapter registers node mcp-mock-server.js via codex mcp add
  → Mock server reads fixture, returns canned responses
```

Both paths converge at `.pathgrade-mcp.json`. The agent-specific adapter decides how to consume it. Adding a new agent requires only a new adapter — the eval config, fixture generation, and mock server are unchanged.

### Agent Adapter Pattern

The normalized `.pathgrade-mcp.json` is the abstraction boundary. Each agent consumes it differently:

| Agent | Mechanism | Adapter Location |
|-------|-----------|-----------------|
| Claude | `--mcp-config` flag (native) | `src/agents/claude.ts` |
| Codex | `codex mcp add` bootstrap commands | `src/agents/codex-mcp.ts` |
| Gemini | Not supported (ignores) | `src/agents/gemini.ts` |
| Future | New adapter reads `.pathgrade-mcp.json` | New agent file |

Supported normalized server shapes (per Codex adapter):
- **stdio:** `{ command, args?, env? }`
- **HTTP:** `{ url, bearerTokenEnvVar? }`

If a server shape contains fields an agent adapter cannot express, PathGrade fails fast with a validation error rather than silently dropping behavior.

## Scope

| Area | Files | What |
|------|-------|------|
| Mock types | `src/core/mcp-mock.types.ts` (new) | `MockMcpTool`, `MockMcpServerConfig`, `MockMcpServerDescriptor` |
| Mock helper | `src/core/mcp-mock.ts` (new) | `mockMcpServer()` function |
| Mock server | `src/mcp-mock-server.ts` (new) | Standalone stdio MCP server |
| Config types | `src/core/config.types.ts` | Add `mcp_mock?` to 4 interfaces |
| Validation | `src/core/config.ts` | Mutual exclusion, `when` regex validation |
| Define eval | `src/core/define-eval.ts` | Pass `mcp_mock` through |
| Task prep | `src/commands/run.ts` | Generate fixture + MCP config in `prepareTempTaskDir` |
| Package | `package.json` | Add `"./mcp-mock"` to exports map |
| Tests | `tests/mcp-mock.test.ts` (new) | Helper, fixture generation, mock server protocol |
| Tests | `tests/config.test.ts` | Mutual exclusion validation |

No changes to: `evalRunner.ts`, `conversationRunner.ts`, `claude.ts`, `codex.ts`, `types.ts`. The mock flow produces the same `.pathgrade-mcp.json` — all downstream plumbing from the `mcp_config` and Codex MCP support plans is reused. Agent adapters are already in place.
