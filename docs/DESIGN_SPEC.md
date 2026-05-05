# Pathgrade Design Specification

**Version**: 0.1.3
**Package**: `pathgrade`
**Runtime**: Node.js 20+, CommonJS
**Dependencies**: `fs-extra`, `jiti`
**Test framework**: Vitest 4+

---

## Table of Contents

- [1. System Overview](#1-system-overview)
- [2. Design Principles](#2-design-principles)
- [3. Architecture](#3-architecture)
  - [3.1 Module Map](#31-module-map)
  - [3.2 Data Flow](#32-data-flow)
  - [3.3 Dependency Graph](#33-dependency-graph)
- [4. Public API (pathgrade)](#4-public-api-pathgrade)
  - [4.1 createAgent](#41-createagent)
  - [4.2 Agent Interface](#42-agent-interface)
  - [4.3 Scorer Factory Functions](#43-scorer-factory-functions)
  - [4.4 evaluate()](#44-evaluate)
  - [4.5 EvalRuntime and LLMPort](#45-evalruntime-and-llmport)
- [5. Agent System](#5-agent-system)
  - [5.1 BaseAgent Contract](#51-baseagent-contract)
  - [5.2 Session Model](#52-session-model)
  - [5.3 Agent Implementations](#53-agent-implementations)
  - [5.4 Agent Registry](#54-agent-registry)
- [6. Workspace Isolation](#6-workspace-isolation)
  - [6.1 prepareWorkspace](#61-prepareworkspace)
  - [6.2 Directory Layout](#62-directory-layout)
  - [6.3 Auth Resolution](#63-auth-resolution)
  - [6.4 Skill Staging](#64-skill-staging)
  - [6.5 MCP Config Staging](#65-mcp-config-staging)
- [7. Interaction Modes](#7-interaction-modes)
  - [7.1 prompt() -- Single-Turn](#71-prompt----single-turn)
  - [7.2 startChat() -- Imperative Multi-Turn](#72-startchat----imperative-multi-turn)
  - [7.3 runConversation() -- Declarative Multi-Turn](#73-startconversation----declarative-multi-turn)
  - [7.4 Interaction Mode Guard](#74-interaction-mode-guard)
- [8. Conversation System](#8-conversation-system)
  - [8.1 runConversation](#81-runconversation)
  - [8.2 Turn Lifecycle](#82-turn-lifecycle)
  - [8.3 Reply Selection](#83-reply-selection)
  - [8.4 Completion Detection](#84-completion-detection)
  - [8.5 Step Scorers](#85-step-scorers)
- [9. Grading System](#9-grading-system)
  - [9.1 Scorer Types](#91-scorer-types)
  - [9.2 check Scorers](#92-check-scorers)
  - [9.3 score Scorers](#93-score-scorers)
  - [9.4 judge Scorers](#94-judge-scorers)
  - [9.5 tool_usage Scorers](#95-tool_usage-scorers)
  - [9.6 Grade Pipeline](#96-grade-pipeline)
  - [9.7 Score Aggregation](#97-score-aggregation)
- [10. Tool Event Pipeline](#10-tool-event-pipeline)
  - [10.1 Normalized Events](#101-normalized-events)
  - [10.2 Extraction Per Agent](#102-extraction-per-agent)
- [11. LLM Boundary](#11-llm-boundary)
  - [11.1 Call Routing](#111-call-routing)
  - [11.2 Provider Fallback Chain](#112-provider-fallback-chain)
- [12. Persona System](#12-persona-system)
- [13. Vitest Plugin (pathgrade/plugin)](#13-vitest-plugin-pathgradeplugin)
  - [13.1 Plugin Configuration](#131-plugin-configuration)
  - [13.2 Setup File and Lifecycle](#132-setup-file-and-lifecycle)
  - [13.3 Reporter](#133-reporter)
  - [13.4 CI Threshold](#134-ci-threshold)
- [14. MCP Integration](#14-mcp-integration)
  - [14.1 Real MCP Pass-Through](#141-real-mcp-pass-through)
  - [14.2 Mock MCP Servers](#142-mock-mcp-servers)
- [15. Timeout and Process Management](#15-timeout-and-process-management)
  - [15.1 Abort Timeout](#151-abort-timeout)
  - [15.2 Agent Auto-Dispose](#152-agent-auto-dispose)
  - [15.3 Process Kill Strategy](#153-process-kill-strategy)
- [16. Package Exports](#16-package-exports)
- [17. Testing Strategy](#17-testing-strategy)
- [18. Known Limitations and Future Work](#18-known-limitations-and-future-work)

---

## 1. System Overview

Pathgrade is a local-first evaluation framework that tests whether AI agents (Claude, Codex) correctly discover and use developer-defined skills. It runs as a Vitest plugin, allowing evaluations to be written as standard `.eval.ts` test files with familiar `describe`/`it` blocks.

**Core problem**: Skills (defined as `SKILL.md` files) provide agents with domain-specific capabilities, but there is no standard way to verify that agents actually find, understand, and correctly use these skills under realistic conditions.

**Core solution**: Pathgrade provides a `createAgent()` + `evaluate()` API, a Vitest plugin for lifecycle management and reporting, pluggable scorers (deterministic and LLM-based), and statistical aggregation. Evaluations are plain Vitest tests: the plugin adds aggregate pass-rate metrics on top of Vitest's default output.

## 2. Design Principles

1. **Local-first**: The entire runtime is local -- no remote orchestrators, no Docker, no cloud APIs for execution. Agents run as local CLI processes.

2. **Tests are tests**: Evaluations are Vitest test files (`.eval.ts`). No custom runner, no `defineEval()` config object. Authors use `createAgent()`, interact with the agent, then `evaluate()` the result. Standard Vitest features (`.each`, `.skip`, `describe.concurrent`) compose naturally.

3. **Isolation by default**: Each agent gets its own filesystem root (workspace, HOME, TMPDIR). No agent can leak state into another agent or the host.

4. **Agent-agnostic grading**: Scorers evaluate outcomes (workspace state, session transcript, tool events), not agent internals. Tool-usage scorers normalize provider-specific traces into canonical actions.

5. **Dependency injection for testability**: The `EvalRuntime` / `LLMPort` boundary allows tests to mock LLM calls and intercept eval results without patching globals.

6. **Minimal dependencies**: Two runtime dependencies (`fs-extra`, `jiti`). Everything else is Node.js built-ins.

## 3. Architecture

### 3.1 Module Map

```
src/
├── test/
│   ├── index.ts              # pathgrade/test — public API barrel
│   ├── types.ts              # All domain types: Agent, Scorer, ScorerContext, etc.
│   ├── agent.ts              # createAgent() + AgentImpl class
│   ├── managed-session.ts    # ManagedSession — turn execution, timeouts, message tracking
│   ├── evaluate.ts           # evaluate() — 3-phase grading pipeline
│   ├── eval-runtime.ts       # EvalRuntime, LLMPort, getRuntime/setRuntime/resetRuntime
│   ├── scorers.ts            # Factory functions: check(), score(), judge(), toolUsage()
│   ├── chat.ts               # ChatSessionImpl — imperative multi-turn
│   ├── converse.ts           # runConversation() — declarative multi-turn
│   └── persona.ts            # createPersona() — LLM-based user simulation
├── plugin/
│   ├── index.ts              # pathgrade/plugin — Vitest plugin factory
│   ├── setup.ts              # Entry point — calls lifecycle.install()
│   ├── lifecycle.ts          # Agent tracking, result collection, afterEach hook
│   └── reporter.ts           # PathgradeReporter — aggregate statistics
├── agents/
│   ├── registry.ts           # Agent factory (name -> instance)
│   ├── claude.ts             # ClaudeAgent — wraps `claude` CLI
│   ├── codex.ts              # CodexAgent — wraps `codex` CLI
│   └── transcript-agent.ts   # TranscriptAgent base for stateless agents
├── providers/
│   ├── workspace.ts          # prepareWorkspace() — facade over sandbox + auth + MCP
│   ├── sandbox.ts            # createSandbox() — directory tree, env, file staging
│   ├── sandbox-exec.ts       # sandboxExec() — command execution in sandbox env
│   ├── credentials.ts        # resolveCredentials() — credential resolution per agent
│   └── mcp-config.ts         # writeMcpConfig() — MCP config file generation
├── core/
│   ├── mcp-mock.ts           # mockMcpServer() factory + validation
│   ├── mcp-mock.types.ts     # Mock MCP type definitions
│   └── skills.ts             # Skill detection and SKILL.md parsing
├── tool-events.ts            # Normalized ToolEvent type and ToolAction enum
├── types.ts                  # Runtime types: BaseAgent, AgentSession, CommandResult, LogEntry
├── viewer.html               # Browser report SPA
├── utils/
│   ├── cli.ts                # Formatting helpers (fmt, header)
│   ├── llm.ts                # createLLMClient() + callLLM() — unified LLM boundary
│   ├── llm-types.ts          # LLMPort, LLMProvider, LLMCallOptions, LLMCallResult
│   ├── llm-providers/
│   │   ├── cli.ts            # Claude/Codex CLI availability detection and LLM calls
│   │   ├── anthropic.ts      # Anthropic API provider
│   │   └── openai.ts         # OpenAI API provider
│   ├── timeout.ts            # AbortSignal-based timeout utility
│   ├── env.ts                # .env file loading utilities
│   ├── fs-extra-interop.ts   # File system interop layer
│   └── shutdown.ts           # Process shutdown manager (SIGTERM/SIGKILL)
├── pathgrade.ts              # CLI entry point; dispatches to run/init/preview commands
├── commands/
│   ├── init.ts               # runInit(): generates example .eval.ts files
│   └── preview.ts            # runPreview(): displays cached results
├── mcp-mock-server.ts        # Node.js process that runs mock MCP servers
├── analytics/
│   └── engine.ts             # Analytics aggregation engine
└── reporters/
    ├── browser.ts            # Standalone browser report viewer
    ├── cli.ts                # Standalone CLI report formatter
    └── results-path.ts       # Results directory path management
```

### 3.2 Data Flow

```
my-eval.eval.ts (vitest test file)
  │
  ├── createAgent({ agent, workspace, ... })
  │     └── prepareWorkspace() ──→ Workspace (isolated dir tree)
  │
  ├── agent.prompt(message) ──→ agent CLI process ──→ response
  │     or agent.startChat(firstMessage) ──→ ChatSession (imperative multi-turn)
  │     or agent.runConversation(opts) ──→ ConversationResult (declarative multi-turn)
  │
  ├── evaluate(agent, scorers)
  │     ├── Phase 1: check + score scorers (parallel)
  │     ├── Phase 2: judge scorers (parallel, LLM) — skipped if fail-fast
  │     ├── Phase 3: tool_usage scorers (parallel) — skipped if fail-fast
  │     └── runtime.onResult(evalResult) ──→ plugin setup.ts collects it
  │
  └── [afterEach hook]
        ├── Attach pathgrade meta to vitest task.meta
        └── lifecycle.flush() ──→ dispose all tracked agents
              │
              └── PathgradeReporter.onTestRunEnd()
                    ├── CLI summary (pass rate, pass@k, pass^k)
                    ├── JSON output (optional)
                    └── CI threshold check (optional)
```

### 3.3 Dependency Graph

Key internal dependency relationships:

```
test/agent.ts
  ├── providers/workspace.ts (prepareWorkspace)
  ├── test/managed-session.ts (createManagedSession)
  ├── plugin/lifecycle.ts (trackAgent, untrackAgent)
  ├── test/chat.ts (ChatSessionImpl)
  ├── test/converse.ts (runConversation)
  ├── test/persona.ts (createPersona)
  └── test/evaluate.ts (evaluate)

test/managed-session.ts
  ├── agents/registry.ts (createAgentEnvironment)
  ├── types.ts (createAgentSession)
  └── utils/timeout.ts (withAbortTimeout)

test/evaluate.ts
  ├── test/eval-runtime.ts (getRuntime for LLM + onResult)
  └── test/types.ts (scorer interfaces)

test/converse.ts
  └── test/types.ts (pure function, deps injected)

plugin/setup.ts
  └── plugin/lifecycle.ts (install)

plugin/lifecycle.ts
  ├── test/eval-runtime.ts (setRuntime for onResult hook)
  └── test/types.ts (Agent, PathgradeTestMeta)

plugin/reporter.ts
  └── test/types.ts (PathgradeTestMeta)

agents/claude.ts ──→ types.ts (BaseAgent, AgentSession)
agents/codex.ts  ──→ agents/transcript-agent.ts ──→ types.ts
```

## 4. Public API (pathgrade)

All public API is exported from `src/sdk/index.ts` and consumed via `import { ... } from '@wix/pathgrade'`.

### 4.1 createAgent

**Location**: `src/sdk/agent.ts`

```typescript
async function createAgent(opts: AgentOptions): Promise<Agent>
```

```typescript
interface AgentOptions {
    agent?: AgentName;                   // 'claude' | 'codex', default: 'claude' (or PATHGRADE_AGENT env)
    timeout?: number;                    // seconds, default: 300
    workspace?: string;                  // path to fixture directory to copy into agent workspace
    skillDir?: string;                   // path to skill directory to stage
    copyFromHome?: string[];             // relative paths to copy from real HOME into sandbox HOME
    env?: Record<string, string>;        // extra env vars to inject into agent environment
    mcpMock?: MockMcpServerDescriptor | MockMcpServerDescriptor[];
}
```

`createAgent()`:
1. Resolves agent name (allows `PATHGRADE_AGENT` env var override, defaults to `'claude'`)
2. Calls `prepareWorkspace()` to create the isolated directory tree
3. Registers the agent for auto-dispose via `lifecycle.trackAgent()`
4. Returns the `Agent` handle -- the agent process is NOT started yet

The agent is spawned lazily on the first `prompt()`, `startChat()`, or `runConversation()` call.

### 4.2 Agent Interface

```typescript
interface Agent {
    prompt(message: string): Promise<string>;
    runConversation(opts: ConverseOptions): Promise<ConversationResult>;
    startChat(firstMessage: string): Promise<ChatSession>;
    exec(cmd: string): Promise<CommandResult>;
    transcript(): string;
    readonly messages: Message[];
    readonly log: LogEntry[];
    readonly workspace: string;
    dispose(): Promise<void>;
}
```

- `prompt()`: Single-turn -- sends one message, returns agent response
- `startChat()`: Returns an imperative `ChatSession` handle for manual multi-turn control
- `runConversation()`: Declarative multi-turn -- runs autonomously per `ConverseOptions`
- `exec()`: Run a shell command in the workspace (for scorer assertions)
- `transcript()`: Formatted `[User]\n...\n\n[Agent]\n...` string
- `messages`: Ordered list of `{ role: 'user' | 'agent', content: string }`
- `log`: Full structured log entries (agent_start, command, agent_result, tool_event, etc.)
- `workspace`: Absolute path to the agent's workspace directory
- `dispose()`: Cleans up workspace directories; safe to call multiple times

### 4.3 Scorer Factory Functions

**Location**: `src/sdk/scorers.ts`

```typescript
function check(
    name: string,
    fn: (ctx: ScorerContext) => boolean | Promise<boolean>,
    opts?: { weight?: number },
): CheckScorer

function score(
    name: string,
    fn: (ctx: ScorerContext) => number | ScoreResult | Promise<number | ScoreResult>,
    opts?: { weight?: number },
): ScoreScorer

function judge(
    name: string,
    opts: {
        rubric: string;
        weight?: number;
        model?: string;
        includeToolEvents?: boolean;
        input?: Record<string, unknown>;
    },
): JudgeScorer

function toolUsage(
    name: string,
    expectations: ToolExpectation[],
    opts?: { weight?: number },
): ToolUsageScorer
```

All factory functions default `weight` to 1.

**ScorerContext** provided to `check()` and `score()` callbacks:

```typescript
interface ScorerContext {
    workspace: string;
    log: LogEntry[];
    transcript: string;
    toolEvents: ToolEvent[];
    runCommand: (cmd: string) => Promise<CommandResult>;
}
```

- `workspace`: Absolute path to the agent workspace
- `log`: Full session log entries
- `transcript`: Formatted transcript string
- `toolEvents`: Pre-extracted normalized tool events from all turns
- `runCommand`: Shell execution in the workspace

### 4.4 evaluate()

**Location**: `src/sdk/evaluate.ts`

```typescript
async function evaluate(
    agent: Agent,
    scorers: Scorer[],
    opts?: { failFast?: boolean },
): Promise<EvalResult>
```

See [Section 9.6](#96-grade-pipeline) for the full pipeline description.

### 4.5 EvalRuntime and LLMPort

**Location**: `src/sdk/eval-runtime.ts`

```typescript
interface LLMPort {
    call(prompt: string, opts?: { model?: string }): Promise<LLMCallResult>;
}

interface EvalRuntime {
    llm: LLMPort;
    onResult: (result: EvalResult) => void;
}
```

Module-level singleton with three accessors:

```typescript
function getRuntime(): EvalRuntime
function setRuntime(partial: Partial<EvalRuntime>): void
function resetRuntime(): void
```

**Default runtime**: `llm` delegates to `callLLM()` from `src/utils/llm.ts`; `onResult` is a no-op.

**Plugin integration**: The plugin's `setup.ts` calls `setRuntime({ onResult })` at module load time to intercept eval results and attach them to Vitest's `task.meta.pathgrade`.

**Test injection**: Unit tests call `setRuntime({ llm: mockLLM })` to avoid real LLM calls in the grading pipeline, then `resetRuntime()` in teardown.

## 5. Agent System

### 5.1 BaseAgent Contract

**Location**: `src/types.ts`

```typescript
abstract class BaseAgent {
    async createSession(
        runtime: EnvironmentHandle,
        runCommand: AgentCommandRunner,
        options?: AgentSessionOptions,
    ): Promise<AgentSession>;

    run(
        instruction: string,
        workspacePath: string,
        runCommand: AgentCommandRunner,
    ): Promise<string>;
}
```

The default `createSession()` wraps `run()` into a simple session for backwards compatibility. Agents that support stateful sessions override `createSession()` directly.

### 5.2 Session Model

```typescript
interface AgentSession {
    start(input: AgentTurnInput): Promise<AgentTurnResult>;
    reply(input: AgentTurnInput): Promise<AgentTurnResult>;
}

interface AgentTurnInput {
    message: string;
    continueSession?: boolean;
}

interface AgentTurnResult {
    rawOutput: string;
    assistantMessage: string;
    visibleAssistantMessage: string;
    visibleAssistantMessageSource: 'assistant_message' | 'blocked_prompt';
    exitCode: number;
    traceOutput?: string;
    timedOut?: boolean;
    blockedPrompts: BlockedInteractivePrompt[];
    toolEvents: ToolEvent[];
}
```

- `start()`: First turn -- initializes a new agent session
- `reply()`: Subsequent turns -- continues an existing session
- `traceOutput`: Raw trace data for tool event extraction (separate from cleaned output)

### 5.3 Agent Implementations

#### ClaudeAgent (`src/agents/claude.ts`)

- **CLI**: `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`
- **Session**: Native session resume via `--resume <session_id>`
- **Trace format**: NDJSON stream with typed lines (`type: 'result'`, `type: 'assistant'` with tool_use blocks)
- **MCP**: Supports `--mcp-config` flag
- **Instruction delivery**: Base64-encoded temp file to avoid shell escaping issues with long prompts
- **Error handling**: Detects API errors via pattern matching, parses denied `AskUserQuestion` calls into structured blocked prompts, and preserves hidden completion text separately from the visible prompt

Key parsing methods:
- `parseStreamJson()`: Extracts result text, session_id, blocked prompts, and visible-turn metadata from NDJSON
- `sanitizeSessionId()`: Prevents injection via session_id
- `extractBlockedPrompts()`: Converts denied interactive prompts into ordered structured prompt objects
- `reconstructFromGenericDenial()`: Extracts text-like fields from any denied tool input

#### CodexAgent (`src/agents/codex.ts`)

- **Base class**: `TranscriptAgent` (`src/agents/transcript-agent.ts`)
- **CLI**: `codex exec --full-auto --skip-git-repo-check`
- **Session**: Stateless -- full transcript is re-injected each turn via `TranscriptAgent`
- **Auth**: Delegated to `src/providers/credentials.ts` — seeds API-key auth via `codex login --with-api-key` when `OPENAI_API_KEY` is available, or reuses a host `~/.codex/auth.json` cache for Codex when present
- **Trace format**: stdout/stderr parsed for `tool:` lines, exec summary patterns, file update blocks

#### TranscriptAgent (`src/agents/transcript-agent.ts`)

Base class for agents without native session persistence. Each turn:
1. Appends the new user message to an in-memory transcript
2. Builds a prompt containing all previous turns plus a continuation instruction
3. Calls `runTurn()` (implemented by subclass)
4. Appends the assistant response to the transcript

Prompt files are written to `$TMPDIR` with a UUID filename to avoid collisions.

### 5.4 Agent Registry

**Location**: `src/agents/registry.ts`

```typescript
function createAgentEnvironment(name: AgentName): BaseAgent
```

Maps `'claude'` to `ClaudeAgent` and `'codex'` to `CodexAgent`. Throws on unknown names. Also exports `getAgentNames()` for listing available agents.

`AgentName` is the union type `'claude' | 'codex'`.

## 6. Workspace Isolation

### 6.1 prepareWorkspace

**Location**: `src/providers/workspace.ts`

```typescript
async function prepareWorkspace(spec: SandboxConfig): Promise<Workspace>
```

The `SandboxConfig` type is defined in `src/providers/sandbox.ts`:

```typescript
interface SandboxConfig {
    agent: 'claude' | 'codex';
    workspace?: string;             // fixture directory to copy into workspace
    skillDir?: string;              // skill directory to stage
    copyFromHome?: string[];        // paths to copy from real HOME
    env?: Record<string, string>;   // extra env vars
    mcp?: McpSpec;                  // MCP server configuration
}

interface Workspace {
    readonly path: string;
    readonly mcpConfigPath: string | undefined;
    readonly env: Record<string, string>;
    readonly setupCommands: string[];
    exec(command: string, opts?: { signal?: AbortSignal }): Promise<CommandResult>;
    dispose(): Promise<void>;
}
```

`prepareWorkspace()` is a facade over `createSandbox()`, `resolveCredentials()`, and `writeMcpConfig()`. It creates the isolated directory tree, copies workspace entries, stages skills, resolves authentication, writes MCP config, and returns a `Workspace` handle.

### 6.2 Directory Layout

Each agent creates a directory tree under `$TMPDIR/pathgrade-<random>/`:

```
pathgrade-abc123/
+-- workspace/     # Task files, agent edits, skill directories
+-- home/          # Isolated HOME directory
+-- tmp/           # Isolated TMPDIR
```

**Environment variables injected**:
- `HOME` -> agent `home/`
- `TMPDIR`, `TMP`, `TEMP` -> agent `tmp/`
- API key vars passed through from host when available: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`

**Process environment for child commands**:
- Only safe host vars are inherited: `PATH`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `USER`, `LOGNAME`
- API key env vars are passed through from the host
- Explicit `env` overrides from `AgentOptions` take precedence

**Skill symlinks**: If skill directories exist in workspace (e.g., `.agents/skills/`, `.claude/skills/`), corresponding symlinks are created in `home/` so agents can discover skills via HOME-relative paths.

**Cleanup**: `fs.remove()` with retry (up to 4 attempts) for ENOTEMPTY/EBUSY/EPERM races.

### 6.3 Auth Resolution

**Location**: `src/providers/credentials.ts`

All agents get a fresh HOME directory. Authentication is resolved per-agent by `resolveCredentials()`, which takes the user's original `opts.env` (not the merged sandbox env) to distinguish explicit user intent from auto-resolved values. All external dependencies (Keychain, host env, filesystem) are injectable via `CredentialPorts` for testability.

- **Claude**: If the user explicitly provided `ANTHROPIC_API_KEY`, no action needed. If the user provided `ANTHROPIC_BASE_URL` (proxy mode), the host's `ANTHROPIC_API_KEY` is forwarded (Keychain is skipped since OAuth tokens only work with direct Anthropic API). Otherwise, on macOS, attempts to extract an OAuth token from the system Keychain (`Claude Code-credentials`). Falls back to forwarding host env vars.

- **Codex**: If the user provided `OPENAI_BASE_URL` without `OPENAI_API_KEY`, the host key is forwarded. If `OPENAI_API_KEY` is available (user-provided or host-forwarded), generates a setup command that runs `codex login --with-api-key` inside the sandbox before the first agent turn. Otherwise, if the host HOME contains `~/.codex/auth.json`, Pathgrade copies that file into the sandbox HOME so the Codex CLI can reuse the existing local login.

### 6.4 Skill Staging

**Location**: `src/providers/sandbox.ts` (inside `createSandbox()`)

When `skillDir` is provided in `AgentOptions`:
1. **Resolve path**: The skill directory is resolved relative to the caller's cwd
2. **Stage to both discovery paths**: The skill is copied into both convention locations so either path resolves regardless of agent type:
   - `.claude/skills/<name>/`
   - `.agents/skills/<name>/`
3. **Filter test dirs**: The `test/` subdirectory is excluded from the copy
4. **Symlink from HOME**: Both skill directories now exist in workspace, so symlinks are created from `home/` for both `.claude/skills/` and `.agents/skills/`

### 6.5 MCP Config Staging

**Location**: `src/providers/mcp-config.ts`

Handled by `writeMcpConfig()`, called from `prepareWorkspace()`. Two modes:

1. **Mock servers**: Each `MockMcpServerDescriptor` is serialized as a fixture JSON file; a `.pathgrade-mcp.json` is generated pointing each server at a Node.js mock server script
2. **None**: No MCP config is staged

## 7. Interaction Modes

An agent supports exactly one interaction method. Calling a second method (e.g., `startChat()` after `prompt()`) throws an error.

### 7.1 prompt() -- Single-Turn

```typescript
agent.prompt(message: string): Promise<string>
```

Sends one message to the agent, waits for the response, and returns it. Can only be called once per agent. The full agent timeout applies.

Internally:
1. Creates a `ManagedSession` via `createManagedSession()`
2. The managed session creates the agent via `createAgentEnvironment()` and opens a session via `createAgentSession()`
3. Calls `managedSession.send(message)` which handles logging, timeout, and message tracking
4. Tool events are returned as part of `AgentTurnResult.toolEvents`
5. Returns the assistant message

### 7.2 startChat() -- Imperative Multi-Turn

```typescript
agent.startChat(firstMessage: string): Promise<ChatSession>
```

Returns a `ChatSession` handle after sending the first message and receiving the first response.

```typescript
interface ChatSession {
    readonly turn: number;
    readonly done: boolean;
    readonly lastMessage: string;
    readonly messages: Message[];
    reply(message: string): Promise<void>;
    hasFile(glob: string): Promise<boolean>;
    end(): void;
}
```

The test author manually drives the conversation:

```typescript
const chat = await agent.startChat('Create a file called hello.txt');
if (chat.lastMessage.includes('Done')) {
    chat.end();
} else {
    await chat.reply('Please confirm the file was created');
}
```

The overall agent timeout is shared across all turns. Each `reply()` call uses a deadline computed from the remaining time budget.

**Location**: `src/sdk/chat.ts` (`ChatSessionImpl`)

### 7.3 runConversation() -- Declarative Multi-Turn

```typescript
agent.runConversation(opts: ConverseOptions): Promise<ConversationResult>
```

```typescript
interface ConverseOptions {
    firstMessage: string;
    maxTurns?: number;            // default: 30
    until?: UntilPredicate;
    reactions?: Reaction[];
    persona?: PersonaConfig;
    stepScorers?: StepScorer[];
}
```

Runs the conversation autonomously according to the options. Returns when `until` is satisfied, `maxTurns` is reached, no reply is available, or the timeout fires.

See [Section 8](#8-conversation-system) for the full conversation runner specification.

### 7.4 Interaction Mode Guard

`AgentImpl` tracks which mode was used first (`'prompt' | 'startChat' | 'runConversation'`). Subsequent calls to a different mode throw:

```
Cannot use startChat() after prompt() -- an agent supports only one interaction method
```

Within a mode, double-calling is also prevented: `prompt()` and `startChat()` can each only be called once per agent.

## 8. Conversation System

### 8.1 runConversation

**Location**: `src/sdk/converse.ts`

```typescript
async function runConversation(
    opts: ConverseOptions,
    deps: ConversationDeps,
): Promise<ConversationResult>
```

Pure function that drives the conversation loop. All side effects (agent calls, file checks, grading) are injected via `ConversationDeps`:

```typescript
interface ConversationDeps {
    sendTurn: (message: string) => Promise<string | AgentTurnResult>;
    hasFile: (pattern: string) => Promise<boolean>;
    workspace: string;
    messages: Message[];       // mutable, runner appends
    log: LogEntry[];           // mutable, runner appends
    personaReply?: () => Promise<string>;
    runStepScorers?: (scorers: Scorer[]) => Promise<EvalResult>;
}
```

### 8.2 Turn Lifecycle

```
Turn 1: send firstMessage
Loop:
  1. If a blocked-prompt queue is active, surface the next local prompt without rerunning the model
  2. Otherwise check until predicate -> done? return 'until'
  3. Check maxTurns -> reached? return 'maxTurns'
  4. Run step scorers scheduled for this turn
  5. Pick reply: reactions first, then persona fallback
  6. No reply available? return 'noReply'
  7. If blocked prompts remain, accept the reply locally and continue replay
  8. Otherwise send reply to agent -> receive response
  9. Goto 1
On error/timeout: return 'timeout'
```

### 8.3 Reply Selection

Priority order:
1. **Reactions**: First regex match against the effective visible assistant turn. While a blocked-prompt queue is active, hidden completion prose from the same model turn is ignored.
2. **Persona**: If no reaction matches and `personaReply` is provided, call it for an LLM-generated reply against the same visible blocked prompt.
3. **No reply**: If neither source produces a reply, conversation ends with `'noReply'`.

```typescript
interface Reaction {
    when: RegExp;
    reply: string;
    once?: boolean;
}
```

### 8.4 Completion Detection

```typescript
type UntilPredicate = (ctx: UntilContext) => boolean | Promise<boolean>;

interface UntilContext {
    turn: number;
    lastMessage: string;
    workspace: string;
    messages: Message[];
    hasFile: (glob: string) => Promise<boolean>;
}
```

The `until` predicate runs after each agent response. It has full access to the conversation state and workspace, including `hasFile()` for checking file existence.

### 8.5 Step Scorers

Run between completion checking and reply selection. Each `StepScorer` specifies:
- `afterTurn`: 0-indexed turn number after which to run
- `scorers`: Array of `Scorer` objects

Step scorer results are collected in the `ConversationResult.stepResults` array.

```typescript
interface ConversationResult {
    turns: number;
    completionReason: 'until' | 'maxTurns' | 'noReply' | 'timeout' | 'error';
    completionDetail?: string;
    turnTimings: TurnTiming[];
    stepResults: Array<{ afterTurn: number; result: EvalResult }>;
}

interface TurnTiming {
    turn: number;
    durationMs: number;
}
```

## 9. Grading System

### 9.1 Scorer Types

**Location**: `src/sdk/types.ts`

Four scorer types, expressed as a discriminated union:

```typescript
type Scorer = CheckScorer | ScoreScorer | JudgeScorer | ToolUsageScorer;
```

Each scorer has `type`, `name`, and `weight` fields. Factory functions in `src/sdk/scorers.ts` construct them.

### 9.2 check Scorers

Boolean gate: passes (1.0) or fails (0.0).

```typescript
interface CheckScorer {
    type: 'check';
    name: string;
    weight: number;
    fn: (ctx: ScorerContext) => boolean | Promise<boolean>;
}
```

A check scoring 0 triggers fail-fast (skips judge and tool_usage phases).

### 9.3 score Scorers

Returns a continuous value in [0, 1], optionally with details.

```typescript
interface ScoreScorer {
    type: 'score';
    name: string;
    weight: number;
    fn: (ctx: ScorerContext) => number | ScoreResult | Promise<number | ScoreResult>;
}

interface ScoreResult {
    score: number;
    details?: string;
}
```

Score returning 0 does NOT trigger fail-fast. The returned value is clamped to [0, 1].

### 9.4 judge Scorers

LLM-evaluated rubric grading. No user-provided function -- the rubric is sent to an LLM which returns a score.

```typescript
interface JudgeScorer {
    type: 'judge';
    name: string;
    weight: number;
    rubric: string;
    model?: string;
    includeToolEvents?: boolean;
    input?: Record<string, unknown>;
}
```

**Prompt construction**:
1. Session transcript is always included
2. Tool events are included if `includeToolEvents` is true
3. Each key in `input` becomes an additional `## key` section
4. The LLM is asked to respond with `{"score": <number>, "reasoning": "<brief explanation>"}`

**LLM call**: Routes through `getRuntime().llm.call()`, allowing test injection.

**Error handling**: If the LLM call or JSON parsing fails, score = 0 with error details.

### 9.5 tool_usage Scorers

Matches pre-extracted tool events against a set of expectations.

```typescript
interface ToolUsageScorer {
    type: 'tool_usage';
    name: string;
    weight: number;
    expectations: ToolExpectation[];
}

interface ToolExpectation {
    action: ToolAction;
    min?: number;           // default: 1
    max?: number;
    path?: string;
    commandContains?: string;
    argumentPattern?: string;   // regex
    toolName?: string;
    weight?: number;            // default: 1
}
```

For each expectation:
1. Filter tool events matching `action`, `toolName`, `path`, `commandContains`, `argumentPattern`
2. Check count against `min` and `max` bounds
3. Score 1.0 if satisfied, 0.0 if violated
4. Weighted average across expectations produces the scorer score

If no tool events were captured, the scorer scores 0.

### 9.6 Grade Pipeline

**Location**: `src/sdk/evaluate.ts`

The `evaluate()` function runs scorers in a 3-phase pipeline with fail-fast:

1. **Phase 1**: `check` + `score` scorers run in parallel (deterministic, fast)
2. **Phase 2**: `judge` scorers run in parallel (LLM calls) -- skipped if any check scored 0
3. **Phase 3**: `tool_usage` scorers run in parallel -- skipped if any check scored 0

Fail-fast: if any `check` scorer scores 0 and `failFast !== false`, phases 2-3 are skipped. Skipped scorers get score 0 with details `'skipped (fail-fast)'`.

After all phases complete:
1. Compute weighted average: `score = sum(score[i] * weight[i]) / sum(weight[i])`
2. Call `getRuntime().onResult(evalResult)` -- this is how the plugin collects results

```typescript
interface EvalResult {
    score: number;
    scorers: ScorerResultEntry[];
}

interface ScorerResultEntry {
    name: string;
    type: 'check' | 'score' | 'judge' | 'tool_usage';
    score: number;
    weight: number;
    details?: string;
}
```

### 9.7 Score Aggregation

**Per-agent score**: Weighted average from `evaluate()`.

**Per-group metrics** (computed by `PathgradeReporter`):
- `pass_rate`: Fraction of tests where `score >= 0.5`
- `pass@k`: `1 - (1 - passRate)^k` -- probability of at least 1 success in k trials
- `pass^k`: `passRate^k` -- probability of all k trials succeeding

## 10. Tool Event Pipeline

### 10.1 Normalized Events

**Location**: `src/tool-events.ts`

```typescript
type ToolAction = 'run_shell' | 'read_file' | 'write_file' | 'edit_file'
  | 'search_code' | 'list_files' | 'ask_user' | 'web_fetch' | 'unknown';

interface ToolEvent {
    action: ToolAction;
    provider: 'claude' | 'codex';
    providerToolName: string;
    turnNumber?: number;
    arguments?: Record<string, unknown>;
    summary: string;
    confidence: 'high' | 'medium' | 'low';
    rawSnippet: string;
}
```

The normalized action vocabulary provides a provider-agnostic view of agent behavior.

### 10.2 Extraction Per Agent

Tool events are extracted eagerly after each agent turn. Each agent's `createSession()` implementation is responsible for extracting tool events from its output format and returning them in `AgentTurnResult.toolEvents`. They are appended to the agent's `log` as `type: 'tool_event'` entries, then re-collected by `evaluate()` into the `ScorerContext.toolEvents` array.

- **Claude**: Parses NDJSON stream lines for `type: 'assistant'` messages containing `tool_use` content blocks. Maps Claude tool names (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `NotebookEdit`, `Agent`, `AskUserQuestion`) to canonical actions. High confidence.

- **Codex**: Three extraction layers:
  1. `tool: <name> <json>` lines -- high confidence
  2. `exec` + command summary lines -- medium confidence, inferred action from command content
  3. `file update` + path lines -- medium confidence, mapped to `edit_file`

A `TOOL_NAME_MAP` maps ~30 provider-specific tool names to canonical `ToolAction` values. Unknown tools map to `'unknown'` with the provider tool name preserved.

## 11. LLM Boundary

### 11.1 Call Routing

**Location**: `src/utils/llm.ts` and `src/utils/llm-providers/`

`callLLM()` is the single boundary for all internal LLM calls (judge grading, persona replies). For grading, it is accessed through `getRuntime().llm.call()`, which defaults to `callLLM()`.

The LLM subsystem uses a multi-provider architecture. `createLLMClient()` creates an `LLMPort` that tries providers in order. The default client uses `[cliProvider, anthropicProvider, openaiProvider]`.

> **Note**: `createPersona()` in `src/sdk/persona.ts` calls `callLLM()` directly, bypassing the `EvalRuntime` LLM port. This means `setRuntime({ llm })` mocks judge scorers but does **not** intercept persona LLM calls. To mock persona replies in tests, inject a custom `personaReply` function via `ConversationDeps` instead of relying on `setRuntime()`.

```typescript
async function callLLM(prompt: string, opts?: LLMCallOptions): Promise<LLMCallResult>

interface LLMCallResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    provider: 'anthropic' | 'openai' | 'cli';
    model: string;
}
```

### 11.2 Provider Fallback Chain

1. **CLI-first**: If Claude CLI is installed and available AND no non-Claude model is requested, routes through the CLI provider (`src/utils/llm-providers/cli.ts`). Uses `-p` (print mode). Supports `--output-format json --json-schema` for structured output.

2. **API-key fallback**: When Claude CLI is unavailable, or a non-Claude model is explicitly requested:
   - Model prefix `claude*` -> Anthropic API with `ANTHROPIC_API_KEY`
   - Model prefix `gpt-*`, `chatgpt-*`, `o1*`, `o3*`, `o4*` -> OpenAI API with `OPENAI_API_KEY`
   - No model specified -> try Anthropic first, then OpenAI
   - Default models: `claude-sonnet-4-20250514` (Anthropic), `gpt-4o` (OpenAI)

3. **Model guard**: Non-Claude models requested without matching API keys throw immediately instead of silently substituting Claude.

4. **CLI fallback on error**: If Claude CLI fails but API keys are available, falls back to API path.

## 12. Persona System

**Location**: `src/sdk/persona.ts`

```typescript
function createPersona(config: PersonaConfig): Persona

interface PersonaConfig {
    description: string;
    facts: string[];
    model?: string;
}

interface Persona {
    reply(chat: ChatSession): Promise<string>;
}
```

`createPersona()` returns a `Persona` that generates context-aware replies via LLM.

**Prompt construction** (`buildPrompt()`):

```
## Persona
{config.description}

## Facts
- {fact1}
- {fact2}

## Conversation History
User: ...
Agent: ...

Reply in character as the persona described above. Respond to the agent's latest message naturally and concisely.
```

The persona is used in `runConversation()` as a fallback reply source when no reaction matches.

## 13. Vitest Plugin (pathgrade/plugin)

### 13.1 Plugin Configuration

**Location**: `src/plugin/index.ts`

```typescript
function pathgrade(opts?: PathgradePluginOptions): VitestPlugin

interface PathgradePluginOptions {
    include?: string[];          // default: ['**/*.eval.ts']
    exclude?: string[];          // default: vitest defaults + ['.worktrees/**', 'worktrees/**']
    timeout?: number;            // seconds, default: 300
    reporter?: 'cli' | 'browser' | 'json';
    scorerModel?: string;
    ci?: {
        threshold?: number;
    };
}
```

The plugin configures vitest:
- `test.include`: Defaults to `['**/*.eval.ts']`
- `test.testTimeout`: `(timeout + 30) * 1000` ms (buffer above agent timeout)
- `test.setupFiles`: Points to `setup.ts`
- `test.reporters`: Default reporter + `PathgradeReporter`

Usage in `vitest.config.ts`:

```typescript
import { pathgrade } from '@wix/pathgrade/plugin';

export default defineConfig({
    plugins: [pathgrade({ timeout: 600, ci: { threshold: 0.7 } })],
});
```

### 13.2 Setup File and Lifecycle

**Location**: `src/plugin/setup.ts` (entry point) and `src/plugin/lifecycle.ts` (implementation)

The setup file runs in each vitest worker process. It calls `lifecycle.install()`, which:

1. Installs an `onResult` handler via `setRuntime()` that collects eval results into a module-level `pendingResults` array
2. Registers an `afterEach` hook (`lifecycle.flush()`) that:
   - Drains `pendingResults` into `task.meta.pathgrade` (vitest's per-test metadata)
   - Disposes all tracked agents to clean up workspace directories

The lifecycle module also exports `trackAgent()` and `untrackAgent()`, used by `AgentImpl` in `src/sdk/agent.ts`.

This bridges the gap between `evaluate()` (in user test code) and the reporter (in the main process). The `task.meta.pathgrade` data is serialized across the worker boundary.

```typescript
declare module 'vitest' {
    interface TaskMeta {
        pathgrade?: PathgradeTestMeta[];
    }
}

interface PathgradeTestMeta {
    score: number;
    scorers: ScorerResultEntry[];
    trial?: TrialResult;
}
```

### 13.3 Reporter

**Location**: `src/plugin/reporter.ts`

`PathgradeReporter` implements vitest's `Reporter` interface. It runs in `onTestRunEnd()` after all tests complete.

**Grouping**: Tests are grouped by parent suite name (describe hierarchy). Tests without a describe wrapper are grouped by module path.

**Output modes**:
- `'cli'` (default): Prints a summary table with pass rate, pass@k, pass^k, avg time, agent count per group
- `'json'`: Writes a timestamped JSON file to `$TMPDIR/pathgrade/results/`
- `'browser'`: Writes JSON + opens `viewer.html` in the system browser

**Score resolution**: Uses the last `pathgrade` entry from `task.meta.pathgrade`. If no pathgrade meta is present, infers score 1 for passed tests and 0 for failed tests.

### 13.4 CI Threshold

When `ci.threshold` is set:
1. Compute the average score across all tests
2. If average < threshold, log a failure message and set `process.exitCode = 1`

## 14. MCP Integration

### 14.1 Real MCP Pass-Through

The internal `McpSpec` type (`src/providers/mcp-config.ts`) supports a `{ configFile: string }` variant that copies a real MCP config file into the workspace as `.pathgrade-mcp.json`. However, this variant is **not currently exposed** through `AgentOptions` — only `mcpMock` is available in the public API. The internal plumbing exists:

1. `writeMcpConfig()` copies the config file into the workspace
2. `Workspace.mcpConfigPath` is set
3. `AgentImpl` passes it to `createAgentSession()` via `AgentSessionOptions`
4. `ClaudeAgent` invokes Claude CLI with `--mcp-config <path>`

Currently Claude only -- `AGENT_CAPABILITIES` in `src/sdk/types.ts` tracks that `codex.mcp === false`.

### 14.2 Mock MCP Servers

**Location**: `src/core/mcp-mock.ts`, `src/core/mcp-mock.types.ts`

```typescript
function mockMcpServer(config: MockMcpServerConfig): MockMcpServerDescriptor

interface MockMcpServerConfig {
    name: string;
    tools: MockMcpTool[];
}

interface MockMcpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;          // regex filter on serialized arguments
    response: unknown;      // canned response
}
```

`mockMcpServer()` validates config (non-empty name, at least one tool, valid regex for `when`) and returns a `MockMcpServerDescriptor` marker object.

At runtime, `prepareWorkspace()` generates a `.pathgrade-mcp.json` that configures lightweight mock MCP server processes (Node.js script). When agents call the tool:
- If `when` is set: response is returned only when the regex matches serialized arguments
- If `when` is not set: response is always returned

Multiple mock servers are supported. Duplicate server names are rejected.

This allows testing skills that depend on external MCP tools without real infrastructure.

## 15. Timeout and Process Management

### 15.1 Abort Timeout

**Location**: `src/utils/timeout.ts`

```typescript
function withAbortTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string,
): Promise<T>
```

- Creates an `AbortController` with the given timeout
- Passes `AbortSignal` to the wrapped function
- On timeout: throws with descriptive message including the label and duration

**Timeout layers**:
1. **Agent timeout**: `opts.timeout * 1000` ms (default 300s) -- covers the entire agent interaction
2. **Per-turn deadline** (multi-turn): Remaining time from the overall budget (`deadlineMs - Date.now()`)
3. **Scorer timeout**: 120s (hardcoded in `src/sdk/evaluate.ts` as `SCORER_TIMEOUT_MS`) -- currently reserved, not yet applied

### 15.2 Agent Auto-Dispose

**Location**: `src/plugin/lifecycle.ts`

Module-level `Set<Agent>` (`pendingAgents`) tracks all active agents. The plugin's `afterEach` hook calls `lifecycle.flush()` to dispose all tracked agents and drain results, ensuring no leaked temp directories even if a test throws before calling `agent.dispose()`.

```typescript
function trackAgent(agent: Agent): void
function untrackAgent(agent: Agent): void
async function flush(task): Promise<void>
```

This is safe because vitest runs test cases sequentially within a file (each file in its own worker).

### 15.3 Process Kill Strategy

**Location**: `src/providers/sandbox-exec.ts`

When an `AbortSignal` fires during command execution:

1. `SIGTERM` to process group (`-pid`) on Unix
2. Wait 250ms
3. `SIGKILL` to process group if still alive
4. Fallback to direct `child.kill()` if process group kill fails

Aborted commands resolve with `exitCode: 124` (matching the `timeout` command convention).

## 16. Package Exports

```json
{
    "./test": "dist/test/index.js",
    "./plugin": "dist/plugin/index.js",
    "./mcp-mock": "dist/core/mcp-mock.js"
}
```

**`pathgrade`** -- Public API for writing evaluations:
- `createAgent`, `evaluate`
- `check`, `score`, `judge`, `toolUsage`
- `createPersona`
- `setRuntime`, `resetRuntime`
- All domain types (`Agent`, `Scorer`, `ScorerContext`, `EvalResult`, etc.)

**`pathgrade/plugin`** -- Vitest plugin:
- `pathgrade()` plugin factory
- `PathgradePluginOptions` type

**`pathgrade/mcp-mock`** -- Mock MCP server factory:
- `mockMcpServer()`
- `MockMcpServerConfig`, `MockMcpTool`, `MockMcpServerDescriptor` types

## 17. Testing Strategy

**Framework**: Vitest with V8 coverage

**Test locations**: `tests/` directory

**Test categories**:
- Grading pipeline tests (phase ordering, fail-fast, score aggregation)
- Agent session tests (MCP config passthrough, flag construction)
- Tool event extraction tests (Claude NDJSON, Codex patterns)
- Mock MCP validation tests
- Workspace isolation tests (layout, environment, cleanup)

## 18. Known Limitations and Future Work

### Current Limitations

1. **Tool event extraction fidelity**: Claude NDJSON traces have the best coverage. Codex trace parsing relies on pattern matching against `tool:` lines and exec summary patterns, which may miss or misclassify some events.

2. **No parallel scorer timeout**: The `SCORER_TIMEOUT_MS` constant (120s) exists but is not yet applied to individual scorer executions.

3. **Codex lacks MCP support**: `AGENT_CAPABILITIES` records `codex.mcp === false`. Mock MCP servers only work with Claude.

4. **Codex session semantics**: The `AGENT_CAPABILITIES` constant in `src/sdk/types.ts` declares `nativeSession: true` for Codex because it uses transcript re-injection (via `TranscriptAgent`) as its session mechanism -- the caller does not need to handle session management differently. However, unlike Claude, which has true CLI-level session persistence via `--resume`, Codex re-injects the full transcript each turn, so the prompt grows linearly with conversation length.

5. **No automatic retries**: Neither agent-level nor turn-level retries are built in. Flaky agent behavior must be handled by running multiple agents.

### Future Work

- Richer transcript and conversation-aware reporting
- Container-based environment providers for resource isolation
- Scorer timeout enforcement
- Additional agent implementations
