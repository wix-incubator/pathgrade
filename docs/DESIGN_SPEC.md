# Pathgrade Design Specification

**Version**: 0.1.3
**Package**: `pathgrade`
**Runtime**: Node.js 20+, CommonJS
**Dependencies**: `fs-extra`, `jiti`

---

## Table of Contents

- [1. System Overview](#1-system-overview)
- [2. Design Principles](#2-design-principles)
- [3. Architecture](#3-architecture)
  - [3.1 Module Map](#31-module-map)
  - [3.2 Data Flow](#32-data-flow)
  - [3.3 Dependency Graph](#33-dependency-graph)
- [4. Configuration System](#4-configuration-system)
  - [4.1 defineEval API](#41-defineeval-api)
  - [4.2 Config Resolution Pipeline](#42-config-resolution-pipeline)
  - [4.3 Type Hierarchy](#43-type-hierarchy)
  - [4.4 Default Values](#44-default-values)
  - [4.5 Validation](#45-validation)
- [5. Agent System](#5-agent-system)
  - [5.1 BaseAgent Contract](#51-baseagent-contract)
  - [5.2 Session Model](#52-session-model)
  - [5.3 Agent Implementations](#53-agent-implementations)
  - [5.4 Agent Registry](#54-agent-registry)
- [6. Execution Runtime](#6-execution-runtime)
  - [6.1 Environment Provider](#61-environment-provider)
  - [6.2 LocalProvider Isolation Model](#62-localprovider-isolation-model)
  - [6.3 Skill Bootstrap](#63-skill-bootstrap)
  - [6.4 Auth Modes](#64-auth-modes)
- [7. Trial Execution](#7-trial-execution)
  - [7.1 EvalRunner Lifecycle](#71-evalrunner-lifecycle)
  - [7.2 Single Trial Flow](#72-single-trial-flow)
  - [7.3 Parallel Execution](#73-parallel-execution)
  - [7.4 Timeout Model](#74-timeout-model)
- [8. Conversation System](#8-conversation-system)
  - [8.1 ConversationRunner](#81-conversationrunner)
  - [8.2 Turn Lifecycle](#82-turn-lifecycle)
  - [8.3 Reply Selection](#83-reply-selection)
  - [8.4 Completion Detection](#84-completion-detection)
  - [8.5 Step Graders](#85-step-graders)
  - [8.6 Retry Logic](#86-retry-logic)
- [9. Grading System](#9-grading-system)
  - [9.1 Grader Descriptors](#91-grader-descriptors)
  - [9.2 Deterministic Graders](#92-deterministic-graders)
  - [9.3 LLM Rubric Graders](#93-llm-rubric-graders)
  - [9.4 Tool Usage Graders](#94-tool-usage-graders)
  - [9.5 Score Aggregation](#95-score-aggregation)
- [10. Tool Event Pipeline](#10-tool-event-pipeline)
  - [10.1 Normalized Events](#101-normalized-events)
  - [10.2 Extraction Per Agent](#102-extraction-per-agent)
- [11. LLM Boundary](#11-llm-boundary)
  - [11.1 Call Routing](#111-call-routing)
  - [11.2 Provider Fallback Chain](#112-provider-fallback-chain)
- [12. Persona System](#12-persona-system)
- [13. Reporting and Analytics](#13-reporting-and-analytics)
  - [13.1 Report Format](#131-report-format)
  - [13.2 Metrics](#132-metrics)
  - [13.3 Log Redaction](#133-log-redaction)
  - [13.4 Analytics Engine](#134-analytics-engine)
- [14. MCP Integration](#14-mcp-integration)
  - [14.1 Real MCP Pass-Through](#141-real-mcp-pass-through)
  - [14.2 Mock MCP Servers](#142-mock-mcp-servers)
- [15. Process Management](#15-process-management)
  - [15.1 Shutdown Manager](#151-shutdown-manager)
  - [15.2 Abort Timeout](#152-abort-timeout)
- [16. CLI Entry Points](#16-cli-entry-points)
  - [16.1 Commands](#161-commands)
  - [16.2 Flag Parsing](#162-flag-parsing)
- [17. Package Exports](#17-package-exports)
- [18. Testing Strategy](#18-testing-strategy)
- [19. Known Limitations and Future Work](#19-known-limitations-and-future-work)

---

## 1. System Overview

Pathgrade is a local-first evaluation framework that tests whether AI agents (Claude, Gemini, Codex) correctly discover and use developer-defined skills. It automates the full eval loop: environment setup, agent invocation, multi-turn conversation orchestration, result grading, and metric reporting.

**Core problem**: Skills (defined as `SKILL.md` files) provide agents with domain-specific capabilities, but there is no standard way to verify that agents actually find, understand, and correctly use these skills under realistic conditions.

**Core solution**: Pathgrade provides a declarative eval config format (`defineEval`), an isolated trial runtime, pluggable graders, and statistical aggregation. This enables skill authors to write evals that test real agent behavior in CI and development.

## 2. Design Principles

1. **Local-first**: The entire runtime is local — no remote orchestrators, no Docker, no cloud APIs for execution. Agents run as local CLI processes.

2. **Isolation by default**: Each trial gets its own filesystem root (HOME, XDG, TMPDIR, workspace). No trial can leak state into another trial or the host.

3. **Agent-agnostic grading**: Graders evaluate outcomes (workspace state, session transcript), not agent internals. Tool-usage graders normalize provider-specific traces into canonical actions.

4. **Determinism where possible**: Deterministic graders run fast and produce reliable scores. LLM-rubric graders add qualitative evaluation where needed. The system never forces one grading strategy.

5. **Composable configuration**: Top-level defaults cascade to tasks. Tasks override any default. Graders, workspace mappings, and conversation configs are independently composable.

6. **Minimal dependencies**: Two runtime dependencies (`fs-extra`, `jiti`). Everything else is Node.js built-ins.

## 3. Architecture

### 3.1 Module Map

```
src/
├── pathgrade.ts                 # CLI router — parses args, dispatches commands
├── commands/
│   ├── run.ts                   # Orchestrates eval execution
│   ├── init.ts                  # Scaffold eval.ts from detected skills
│   └── preview.ts               # Display saved reports
├── core/
│   ├── config.ts                # Config loading, validation, resolution
│   ├── config.types.ts          # Type definitions for eval config
│   ├── define-eval.ts           # defineEval() public API
│   ├── defaults.ts              # Default config values (single source of truth)
│   ├── grader-factories.ts      # Factory functions: deterministicGrader, llmRubricGrader, toolUsageGrader
│   ├── index.ts                 # Package entry point (re-exports)
│   ├── mcp-mock.ts              # mockMcpServer() factory + validation
│   ├── mcp-mock.types.ts        # Mock MCP type definitions
│   └── skills.ts                # SKILL.md detection
├── agents/
│   ├── registry.ts              # Agent factory (name → instance)
│   ├── claude.ts                # ClaudeAgent — wraps `claude` CLI
│   ├── gemini.ts                # GeminiAgent — wraps `gemini` CLI
│   ├── codex.ts                 # CodexAgent — wraps `codex` CLI
│   └── transcript-agent.ts      # TranscriptAgent base for stateless agents
├── providers/
│   ├── local.ts                 # LocalProvider — filesystem isolation
│   └── skill-bootstrap.ts       # Skill staging to .claude/skills, .agents/skills, etc.
├── graders/
│   ├── index.ts                 # LLMGrader class
│   ├── tool-usage.ts            # ToolUsageGrader class
│   └── paths.ts                 # Path conventions for grader files in workspace
├── reporters/
│   ├── cli.ts                   # Terminal table output
│   └── browser.ts               # HTML report launcher
├── analytics/
│   └── engine.ts                # Normalized Gain calculation
├── conversationRunner.ts        # Multi-turn conversation orchestration
├── evalRunner.ts                # Trial lifecycle management
├── persona.ts                   # Persona prompt construction and LLM reply generation
├── tool-events.ts               # Normalized ToolEvent type and ToolAction enum
├── tool-event-extractors.ts     # Per-agent trace parsing
├── types.ts                     # Core interfaces: TrialResult, EvalReport, BaseAgent, etc.
├── viewer.html                  # Browser report SPA
└── utils/
    ├── cli.ts                   # Formatting helpers, Spinner class
    ├── cli-llm.ts               # Claude CLI availability detection and call
    ├── llm.ts                   # Unified LLM call boundary
    ├── env.ts                   # .env file loading
    ├── shutdown.ts              # SIGINT/SIGTERM cleanup manager
    └── timeout.ts               # AbortSignal-based timeout utility
```

### 3.2 Data Flow

```
eval.ts
  │
  ├── defineEval() ──→ validateConfig() ──→ EvalConfig
  │                                            │
  │                                     ┌──────┴──────┐
  │                                     │  run.ts     │
  │                                     │  resolves   │
  │                                     │  tasks      │
  │                                     └──────┬──────┘
  │                                            │
  │                        ┌───────────────────┼───────────────────┐
  │                        │                   │                   │
  │                   ResolvedTask         ResolvedTask        ResolvedTask
  │                        │                   │                   │
  │                   EvalRunner           EvalRunner          EvalRunner
  │                        │                   │                   │
  │              ┌─────────┴────────┐          │                   │
  │              │                  │          ...                 ...
  │          Trial 1           Trial 2
  │              │                  │
  │    ┌────────┴────────┐         │
  │    │                 │         │
  │  LocalProvider    AgentSession │
  │  setup()          start()     │
  │    │              reply()     │
  │    │                 │         │
  │    │    ┌────────────┘         │
  │    │    │                      │
  │    │  Graders                  │
  │    │  (sequential)             │
  │    │    │                      │
  │    │  TrialResult              │
  │    │    │                      │
  │    └────┴───→ EvalReport       │
  │                   │            │
  │              saveReport()      │
  │              CLI/Browser       │
  └───────────────────────────────-┘
```

### 3.3 Dependency Graph

Key internal dependency relationships:

```
commands/run.ts
  ├── core/config.ts (load and validate)
  ├── agents/registry.ts (create agent)
  ├── providers/local.ts (create provider)
  ├── evalRunner.ts (run trials)
  └── reporters/cli.ts | browser.ts (output)

evalRunner.ts
  ├── conversationRunner.ts (conversation trials)
  ├── graders/index.ts (LLM rubric)
  ├── graders/tool-usage.ts (tool usage)
  ├── tool-event-extractors.ts (trace parsing)
  └── utils/timeout.ts (abort handling)

conversationRunner.ts
  ├── persona.ts (LLM persona replies)
  ├── graders/index.ts (step graders)
  ├── tool-event-extractors.ts
  └── utils/llm.ts (done_when check)

agents/claude.ts → types.ts (BaseAgent, AgentSession)
agents/gemini.ts → agents/transcript-agent.ts → types.ts
agents/codex.ts  → agents/transcript-agent.ts → types.ts
```

## 4. Configuration System

### 4.1 defineEval API

**Location**: `src/core/define-eval.ts`

```typescript
function defineEval(input: DefineEvalInput): EvalConfig
```

Accepts a user-friendly input shape and returns a validated `EvalConfig`. The function:
1. Applies version defaults
2. Maps task inputs to config format
3. Passes grader descriptors through untouched (factory functions already produce the right shape)
4. Delegates to `validateConfig()` for full validation

### 4.2 Config Resolution Pipeline

**Location**: `src/core/config.ts`

The resolution pipeline runs in `commands/run.ts`:

1. **Load**: `jiti` dynamically imports the TypeScript `eval.ts` file
2. **Validate**: `validateConfig()` checks schema, agent names, grader types, task structure
3. **Resolve**: `resolveTask()` per task:
   - Merges task-level overrides with defaults
   - Reads file references for `instruction`, `rubric`, `reply` fields
   - Expands `{ dir: ... }` workspace entries into individual file mappings
   - Resolves `conversation.reactions` reply content from files
   - Resolves `conversation.step_graders` with full grader descriptors

### 4.3 Type Hierarchy

```
DefineEvalInput                    (user-facing input)
  └── defineEval() ──→ EvalConfig  (validated raw config)
                          │
                     resolveTask()
                          │
                    ResolvedTask    (execution-ready)
                          │
                    ┌─────┴─────┐
          ResolvedInstructionTask   ResolvedConversationTask
```

**Key type files**:
- `src/core/config.types.ts`: All config types (input, raw, resolved)
- `src/types.ts`: Runtime types (TrialResult, EvalReport, AgentSession, etc.)
- `src/core/grader-factories.ts`: GraderDescriptor, GraderContext

### 4.4 Default Values

**Location**: `src/core/defaults.ts`

```typescript
const DEFAULT_CONFIG: EvalDefaults = {
  agent: 'gemini',
  trials: 5,
  timeout: 300,
  threshold: 0.8,
  environment: { cpus: 2, memory_mb: 2048 },
};
```

This is the single source of truth for defaults, shared by config validation and task resolution.

### 4.5 Validation

`validateConfig()` performs:

- Schema shape validation (required fields, correct types)
- Agent name validation against `VALID_AGENTS` (`claude`, `gemini`, `codex`)
- Grader type validation against `VALID_GRADER_TYPES` (`deterministic`, `llm_rubric`, `tool_usage`)
- Task structure: instruction tasks must have `instruction`, conversation tasks must have `conversation`
- At least one grader per task
- Grader weights are positive numbers
- Descriptive error messages with task name and field context

## 5. Agent System

### 5.1 BaseAgent Contract

**Location**: `src/types.ts`

```typescript
abstract class BaseAgent {
  async createSession(
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner,
    options?: AgentSessionOptions
  ): Promise<AgentSession>;

  run(instruction: string, workspacePath: string, runCommand: AgentCommandRunner): Promise<string>;
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
  exitCode: number;
  traceOutput?: string;
}
```

- `start()`: First turn — initializes a new agent session
- `reply()`: Subsequent turns — continues an existing session
- `traceOutput`: Raw trace data for tool event extraction (separate from cleaned output)

### 5.3 Agent Implementations

#### ClaudeAgent (`src/agents/claude.ts`)

- **CLI**: `claude -p --output-format stream-json --verbose --dangerously-skip-permissions`
- **Session**: Native session resume via `--resume <session_id>`
- **Trace format**: NDJSON stream with typed lines (`type: 'result'`, tool call envelopes)
- **MCP**: Supports `--mcp-config` flag
- **Instruction delivery**: Base64-encoded temp file to avoid shell escaping issues
- **Error handling**: Detects API errors via pattern matching, reconstructs text from denied AskUserQuestion tool calls

Key parsing methods:
- `parseStreamJson()`: Extracts result text and session_id from NDJSON
- `sanitizeSessionId()`: Prevents injection via session_id
- `reconstructFromAskUserQuestion()`: Recovers text when interactive tools are denied in print mode

#### GeminiAgent / CodexAgent (`src/agents/gemini.ts`, `src/agents/codex.ts`)

- **Base class**: `TranscriptAgent` (`src/agents/transcript-agent.ts`)
- **Session**: Stateless — full transcript is re-injected each turn
- **Trace format**: `tool: <name> <json>` lines in stdout/stderr
- **Continuation**: Each turn sends all previous messages as a formatted transcript, followed by the new message

### 5.4 Agent Registry

**Location**: `src/agents/registry.ts`

Factory function that maps agent name to instance:

```typescript
function createAgent(name: AgentName): BaseAgent
```

Returns `ClaudeAgent`, `GeminiAgent`, or `CodexAgent` based on the name string.

## 6. Execution Runtime

### 6.1 Environment Provider

**Location**: `src/types.ts` (interface), `src/providers/local.ts` (implementation)

```typescript
interface EnvironmentProvider {
  prepare?(taskPath, skillsPaths, opts, env): Promise<string>;
  setup(taskPath, skillsPaths, opts, env): Promise<EnvironmentHandle>;
  cleanup(handle): Promise<void>;
  teardown?(): Promise<void>;
  runCommand(handle, command, env?, options?): Promise<CommandResult>;
  diagnose?(handle): Promise<string>;
}
```

Only `LocalProvider` exists. The interface is retained for potential future providers.

### 6.2 LocalProvider Isolation Model

Each trial creates a directory tree under `$TMPDIR/pathgrade-<random>/`:

```
pathgrade-abc123/
├── workspace/     # Task files, agent edits, skill directories
├── home/          # Isolated HOME (or host HOME in host-auth mode)
├── xdg/           # XDG_CONFIG_HOME
│   ├── state/     # XDG_STATE_HOME
│   └── cache/     # XDG_CACHE_HOME
└── tmp/           # Isolated TMPDIR
```

**Environment variables injected** (isolated mode):
- `HOME` → trial `home/`
- `XDG_CONFIG_HOME` → trial `xdg/`
- `XDG_STATE_HOME` → trial `xdg/state/`
- `XDG_CACHE_HOME` → trial `xdg/cache/`
- `TMPDIR`, `TMP`, `TEMP` → trial `tmp/`

**Process environment for child commands** (isolated mode):
- Only safe host vars are inherited: `PATH`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `USER`, `LOGNAME`
- User-provided `env` (API keys) are merged
- Runtime env overrides all

**Cleanup**: `fs.remove()` with retry (up to 4 attempts) for ENOTEMPTY/EBUSY/EPERM races.

### 6.3 Skill Bootstrap

**Location**: `src/providers/skill-bootstrap.ts`

When skills are detected:
1. **Read descriptors**: Parse `SKILL.md` frontmatter for display name and directory name
2. **Stage skills**: Copy skill directories into multiple locations:
   - `.agents/skills/<name>/` (Codex)
   - `.claude/skills/<name>/` (Claude)
   - `.pathgrade/skills/<name>/` (generic)
3. **Generate bootstrap files**:
   - `CLAUDE.md`: References staged skill paths for Claude's skill discovery
   - `AGENTS.md`: Composed with existing content + new skill references for Codex

### 6.4 Auth Modes

**Isolated** (default): Fresh HOME directory. Agent must authenticate via API keys in environment. Reproducible across machines.

**Host**: Real HOME preserved. Agent can use saved CLI credentials (OAuth sessions, `~/.codex/auth.json`). Workspace still isolated via `cwd`. Less reproducible but convenient for development.

**Codex host-auth**: Special case — when `authMode: 'host'` AND `PATHGRADE_CODEX_USE_HOST_AUTH=1`, creates an isolated HOME but copies `~/.codex/auth.json` and shared skill support files into it.

## 7. Trial Execution

### 7.1 EvalRunner Lifecycle

**Location**: `src/evalRunner.ts`

```
EvalRunner.runEval()
  ├── provider.prepare() (optional, one-time)
  ├── for each trial:
  │     ├── runSingleTrial()
  │     │     ├── provider.setup() → TrialRuntime
  │     │     ├── createAgentSession()
  │     │     ├── conversation? → runConversationTrial()
  │     │     │   instruction? → session.start()
  │     │     ├── extractToolEvents()
  │     │     ├── runGraders()
  │     │     └── provider.cleanup()
  │     └── TrialResult
  ├── provider.teardown() (optional)
  ├── aggregate metrics
  └── saveReport() → EvalReport
```

### 7.2 Single Trial Flow

1. **Setup**: `LocalProvider.setup()` creates isolated directories, copies workspace, stages skills
2. **Register cleanup**: `ShutdownManager.register()` ensures cleanup on SIGINT
3. **Execute agent**:
   - **Instruction**: Single `session.start()` call with timeout
   - **Conversation**: Delegates to `runConversationTrial()`
4. **Extract tool events**: `extractToolEvents()` parses trace output into normalized `ToolEvent[]`
5. **Grade**: All graders run sequentially (each with its own timeout)
6. **Compute reward**: Weighted average of grader scores
7. **Cleanup**: Unregister shutdown handler, `provider.cleanup()`

On error: reward = 0, empty grader results, error message in session log.

### 7.3 Parallel Execution

When `parallel > 1`:
- Worker pool of `min(parallel, numTrials)` workers
- Each worker pulls from a shared queue
- Results stored in a pre-allocated array by index
- No shared mutable state between trials

### 7.4 Timeout Model

**Location**: `src/utils/timeout.ts`

```typescript
async function withAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T>
```

- Creates an `AbortController` with the given timeout
- Passes `AbortSignal` to the wrapped function
- On timeout: throws with descriptive message including the label
- The signal propagates to `LocalProvider.runCommand()`, which kills the child process group

**Timeout layers**:
1. **Trial timeout**: `opts.timeoutSec * 1000` — covers the entire agent execution
2. **Grader timeout**: `opts.graderTimeoutSec ?? 120` seconds — per grader
3. **Conversation timeout**: `conversation.completion.timeout` seconds — total conversation budget
4. **Per-turn deadline**: Remaining time from conversation budget

## 8. Conversation System

### 8.1 ConversationRunner

**Location**: `src/conversationRunner.ts`

Exported function:

```typescript
async function runConversationTrial(opts: ConversationRunOptions): Promise<ConversationRunResult>
```

### 8.2 Turn Lifecycle

```
for each turn:
  1. Check remaining time budget
  2. Send message to agent (start or reply)
  3. Normalize assistant message
  4. Record turn in transcript
  5. Extract tool events from trace
  6. Check completion conditions
  7. Run step graders (if any for this turn)
  8. If complete → return
  9. Pick next reply (reaction or persona)
  10. If no reply available → return with 'no_replies'
```

### 8.3 Reply Selection

**Location**: `pickReaction()` in `src/conversationRunner.ts`

Priority order:
1. **Reactions**: First regex match against assistant's latest message (case-insensitive). Skip `once` reactions already used.
2. **Persona**: If no reaction matches and a persona is configured, generate an LLM reply via `generatePersonaReply()`. Retries once on failure.
3. **No reply**: If neither source produces a reply, conversation ends with `no_replies`.

**Reaction compilation**: At conversation start, all reaction `when` patterns are compiled to `RegExp` objects with the `i` flag. The `used` flag tracks `once` consumption.

### 8.4 Completion Detection

**Location**: `checkCompletion()` in `src/conversationRunner.ts`

Check order (stops at first match):
1. **Signal**: Glob pattern checked against workspace files via recursive directory walk
2. **Done phrase**: Regex tested against assistant's latest message
3. **Max turns**: Hard limit — checked before `done_when` to avoid wasteful LLM call on the last turn
4. **Done when**: LLM-judged semantic condition. Sends full transcript to LLM, asks for `{"done": true/false}`. Includes prompt injection guard: transcript is wrapped in data tags with explicit instructions not to follow content within.

### 8.5 Step Graders

Run after completion checks, before reply selection. Each `StepGraderConfig` specifies:
- `after_turn`: 1-indexed turn number
- `graders`: Array of `GraderDescriptor` (same types as task graders)

Step grader results are attached to the turn and logged as `step_grader` entries.

### 8.6 Retry Logic

Each turn has a single retry for transient failures:
- **Empty response with non-zero exit**: Retries once
- **Non-timeout errors**: Retries once
- **Timeouts**: Never retried (consume the remaining budget)
- **Second failure**: Records error, ends conversation with `error` reason

## 9. Grading System

### 9.1 Grader Descriptors

**Location**: `src/core/grader-factories.ts`

```typescript
interface GraderDescriptor {
  type: GraderType;              // 'deterministic' | 'llm_rubric' | 'tool_usage'
  weight: number;
  execute?: (ctx: GraderContext) => Promise<GraderOutput>;  // deterministic
  rubric?: string;                // llm_rubric
  model?: string;                 // llm_rubric
  include_tool_events?: boolean;  // llm_rubric
  expectations?: ToolUsageExpectation[];  // tool_usage
}
```

Factory functions (`deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`) construct descriptors with correct types and default weights of 1.0.

### 9.2 Deterministic Graders

**Execution**: Calls `descriptor.execute(ctx)` directly in the pathgrade process.

**GraderContext** provides:
- `workspacePath`: Absolute path to trial workspace
- `runCommand(cmd)`: Shell execution in workspace with signal propagation
- `sessionLog`: Full session log entries
- `env`: Environment variables (API keys, etc.)
- `signal`: AbortSignal for timeout

**GraderOutput** contract:
```typescript
{ score: number; details?: string; checks?: GraderCheck[] }
```

Score is clamped to [0, 1]. Checks are rendered as checkmarks in reports.

**Error handling**: If `execute()` throws, score = 0 with error in details.

### 9.3 LLM Rubric Graders

**Location**: `src/graders/index.ts`

The `LLMGrader` class:
1. Writes the rubric to a file in the workspace (path from `src/graders/paths.ts`)
2. Builds a transcript from session log entries (agent_start, agent_result, command entries)
3. Optionally appends tool event summaries if `include_tool_events` is true
4. Calls `callLLM()` with the rubric + transcript
5. Parses JSON `{score, reasoning}` from LLM response
6. Returns `GraderResult` with score and reasoning as details

**Rubric prompt structure**: Rubric text is provided as a scoring guide. The LLM is asked to evaluate the transcript and return a JSON score.

### 9.4 Tool Usage Graders

**Location**: `src/graders/tool-usage.ts`

The `ToolUsageGrader` class:
1. Extracts `ToolEvent[]` from session log entries of type `tool_event`
2. For each expectation, counts matching events:
   - Filters by `action`, `provider`, `path`, `command_contains`, `argument_pattern`, `tool_name`
   - Checks `min` and `max` bounds
3. Each expectation scores 1.0 (satisfied) or 0.0 (violated)
4. Weighted average across expectations produces the final score

### 9.5 Score Aggregation

**Per-trial reward**:
```
reward = Σ(grader_score[i] × weight[i]) / Σ(weight[i])
```

**Per-eval metrics**:
- `pass_rate`: `Σ(trial.reward) / num_trials` (mean reward, not binary pass count)
- `pass_at_k`: `1 - Π((n-c-i)/(n-i))` for i in 0..k-1, where n = total trials, c = successes (reward >= 0.5)
- `pass_pow_k`: `(c/n)^k` — probability all k trials succeed

## 10. Tool Event Pipeline

### 10.1 Normalized Events

**Location**: `src/tool-events.ts`

```typescript
type ToolAction = 'run_shell' | 'read_file' | 'write_file' | 'edit_file'
  | 'search_code' | 'list_files' | 'ask_user' | 'web_fetch' | 'unknown';

interface ToolEvent {
  action: ToolAction;
  provider: 'claude' | 'codex' | 'gemini';
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

**Location**: `src/tool-event-extractors.ts`

- **Claude**: Parses NDJSON stream lines for tool call events. Maps Claude tool names (Bash, Read, Edit, Write, Grep, Glob, etc.) to canonical actions. High confidence.
- **Gemini**: Parses `tool: <name> <json>` lines from stdout/stderr. Medium confidence.
- **Codex**: Parses `tool: <name> <json>` lines + execution summary patterns. Medium confidence.

The extraction is best-effort — unknown tools map to `action: 'unknown'` with the provider tool name preserved.

## 11. LLM Boundary

### 11.1 Call Routing

**Location**: `src/utils/llm.ts` and `src/utils/cli-llm.ts`

`callLLM()` is the single boundary for all LLM calls (grading, persona, init, done_when checks).

### 11.2 Provider Fallback Chain

1. **CLI-first**: If Claude CLI is installed with an active OAuth session AND no non-Claude model is requested, routes through `callClaudeCli()`. Uses the host's OAuth session (not the trial's isolated HOME).

2. **API-key fallback**: When Claude CLI is unavailable, or a non-Claude model is explicitly requested:
   - If model starts with `gemini`: calls Gemini API with `GEMINI_API_KEY`
   - Else if `ANTHROPIC_API_KEY` is set: calls Anthropic API
   - Else if `OPENAI_API_KEY` is set: calls OpenAI API
   - Else: throws with a clear error

3. **Model guard**: Non-Claude models requested without matching API keys throw immediately instead of silently substituting Claude.

## 12. Persona System

**Location**: `src/persona.ts`

### Prompt Construction

`buildPersonaPrompt()` constructs a system prompt:
```
You are simulating a user in a conversation with an AI assistant.

## Who You Are
{persona.description}

## What You Know
{persona.facts as bullet list}

## Conversation So Far
{transcript formatted as User/Assistant turns}

## Agent's Latest Message
{latest assistant message}

## Instructions
Respond as the user would. Be concise and natural.
Pick appropriate options. Confirm if correct.
Do not break character. Plain text only.
```

### Reply Generation

`generatePersonaReply()`:
1. Builds the persona prompt
2. Calls `callLLM()` with optional model override
3. Returns `{ content, inputTokens, outputTokens }`

Token usage is tracked per-trial for reporting.

## 13. Reporting and Analytics

### 13.1 Report Format

**Location**: `src/types.ts`

```typescript
interface EvalReport {
  task: string;
  pass_rate: number;
  pass_at_k: number;
  pass_pow_k: number;
  trials: TrialResult[];
  skills_used: string[];
}

interface TrialResult {
  trial_id: number;
  reward: number;
  grader_results: GraderResult[];
  duration_ms: number;
  n_commands: number;
  input_tokens: number;
  output_tokens: number;
  persona_input_tokens?: number;
  persona_output_tokens?: number;
  session_log: LogEntry[];
  conversation?: {
    turns: ConversationTurn[];
    total_turns: number;
    completion_reason: ConversationCompletionReason;
    timeout_triggered_at_turn?: number;
  };
}
```

### 13.2 Metrics

- **Token estimation**: `Math.ceil(text.length / 4)` — simple character-based approximation
- **Pass metrics**: See [Score Aggregation](#95-score-aggregation)
- **Duration**: Wall-clock time from trial start (including setup) to grading completion

### 13.3 Log Redaction

**Location**: `EvalRunner.sanitize()`

Before persisting reports:
1. Collects all environment variable values longer than 5 characters
2. Deep-clones the report
3. Replaces all occurrences of secret values with `[REDACTED]` in:
   - Session log fields: instruction, command, stdout, stderr, output, assistant_message
   - Grader result details
   - Tool event rawSnippet, summary, string arguments
   - Conversation turn messages

### 13.4 Analytics Engine

**Location**: `src/analytics/engine.ts`

Computes Normalized Gain (NG) for with-skill vs. without-skill comparisons:

```
NG = (p_with - p_without) / (1 - p_without)
```

Special cases:
- `p_without = 1` and `p_with = 1` → NG = 0
- `p_without = 1` and `p_with < 1` → NG = -1

Groups reports by task name and skill presence for aggregation.

## 14. MCP Integration

### 14.1 Real MCP Pass-Through

**Claude only**. When `mcp_config` is set on a task:
1. Config resolution copies the file path
2. `EvalRunner` stages the config into the workspace as `.pathgrade-mcp.json`
3. `ClaudeAgent` receives it via `AgentSessionOptions.mcpConfigPath`
4. Claude CLI is invoked with `--mcp-config <path>`

### 14.2 Mock MCP Servers

**Location**: `src/core/mcp-mock.ts`, `src/core/mcp-mock.types.ts`

```typescript
interface MockMcpServerConfig {
  name: string;
  tools: MockMcpTool[];
}

interface MockMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  when?: string;          // Regex filter on serialized arguments
  response: unknown;      // Canned response
}
```

`mockMcpServer()` validates config (non-empty name, at least one tool, valid regex for `when`) and returns a `MockMcpServerDescriptor` marker object.

At runtime, pathgrade generates a `.pathgrade-mcp.json` file that configures a lightweight MCP server. When agents call the tool:
- If `when` is set: response is returned only when the regex matches serialized arguments
- If `when` is not set: response is always returned

This allows testing skills that depend on external MCP tools without real infrastructure.

## 15. Process Management

### 15.1 Shutdown Manager

**Location**: `src/utils/shutdown.ts`

`ShutdownManager` provides graceful cleanup on Ctrl+C:
- `register(fn)`: Adds a cleanup function, returns an ID
- `unregister(id)`: Removes a cleanup function
- On SIGINT/SIGTERM: runs all registered cleanup functions, then exits

Each trial registers `provider.cleanup(runtime)` on setup and unregisters it after normal cleanup.

### 15.2 Abort Timeout

**Location**: `src/utils/timeout.ts`

`withAbortTimeout(fn, timeoutMs, label)`:
- Creates `AbortController` with timeout
- Passes signal to `fn`
- On timeout: throws `Error` with label and duration
- Signal propagates through `LocalProvider.runCommand()` to kill child process groups

Process killing strategy (Unix):
1. `SIGTERM` to process group (`-pid`)
2. Wait 250ms
3. `SIGKILL` to process group if still alive

## 16. CLI Entry Points

### 16.1 Commands

**Location**: `src/pathgrade.ts` (router), `src/commands/*.ts`

| Command | Module | Description |
|---------|--------|-------------|
| (default) | `commands/run.ts` | Run all evals |
| `init` | `commands/init.ts` | Generate eval.ts from detected skills |
| `preview` | `commands/preview.ts` | Display saved reports |
| `preview browser` | `commands/preview.ts` | Open HTML report |

### 16.2 Flag Parsing

`src/pathgrade.ts` manually parses `process.argv`:
- Preset flags: `--smoke` (5), `--reliable` (15), `--regression` (30)
- Override flags: `--trials=N`, `--parallel=N`, `--agent=NAME`
- Filter flags: `--eval=NAME[,NAME]`, `--grader=TYPE`
- Output flags: `--output=DIR`, `--preview`
- CI flags: `--ci`, `--threshold=N`
- Init flags: `--force`
- Validation: `--validate`

## 17. Package Exports

```json
{
  ".": "core/index.js",               // defineEval, factory functions, types
  "./config": "core/define-eval.js",   // defineEval (alias)
  "./mcp-mock": "core/mcp-mock.js"     // mockMcpServer, types
}
```

The main entry point (`core/index.ts`) re-exports:
- `defineEval`
- `deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`
- Config types (`AgentName`, `DefineEvalInput`, `GraderDescriptor`, `GraderContext`, etc.)
- `GraderOutput`, `GraderCheck` from `types.ts`

`mockMcpServer` is available separately via `pathgrade/mcp-mock`.

## 18. Testing Strategy

**Framework**: Vitest with V8 coverage

**Test locations**: `tests/` directory

**Test categories**:
- Config validation tests
- Agent session tests (MCP config passthrough, flag construction)
- Grader factory tests
- Tool event extraction tests
- Mock MCP validation tests

**Living examples**: `examples/` contains real eval configs that serve as integration test fixtures:
- `superlint/`: Simple instruction task with deterministic + LLM rubric graders
- `ck-new/`: Complex multi-task eval with conversations, reactions, personas, mock MCP
- `angular-modern/`, `typescript-example/`, `ck-product-strategy/`, `tool-usage/`: Additional examples

**Validation mode**: `--validate` runs graders against a reference solution to catch broken graders before eval execution.

## 19. Known Limitations and Future Work

### Current Limitations

1. **Tool event extraction fidelity**: Claude NDJSON traces have the best coverage. Gemini and Codex trace parsing relies on pattern matching against `tool:` lines, which may miss or misclassify some events.

2. **No conversation-aware `--validate`**: The validate mode only works for instruction tasks. Conversation task validation requires simulating the multi-turn flow.

3. **Sequential grader execution**: Graders within a trial run sequentially (not parallel). This is primarily a concern for tasks with many LLM rubric graders.

4. **Token estimation**: Uses `text.length / 4` approximation. Real token counts would require tokenizer integration.

5. **No native retry for flaky agents**: Trial-level retries are not supported. The conversation runner retries individual turns once, but instruction tasks have no retry mechanism.

6. **Environment resource hints are unused**: `environment.cpus` and `environment.memory_mb` are accepted in config but not enforced. Reserved for future container-based providers.

### Future Work

- Codex CLI skill bootstrap with generated `AGENTS.md` and staged skill directories
- Conversation-aware `--validate` support
- Richer transcript and reporting support
- Conversation-aware browser/CLI reporting
- Parallel grader execution within trials
- Container-based environment providers for resource isolation
