# Pathgrade User Guide

Pathgrade evaluates whether AI agents correctly discover and use your skills. You write evaluations as vitest tests that create isolated workspaces, run agents, and evaluate the results with deterministic checks, LLM judges, and tool-usage matchers.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Writing Evals](#writing-evals)
  - [File Structure](#file-structure)
  - [createAgent](#createagent)
  - [Workspace Setup](#workspace-setup)
  - [Instruction Tasks](#instruction-tasks)
- [Scorers](#scorers)
  - [check() -- Boolean Gates](#check----boolean-gates)
  - [score() -- Partial Credit](#score----partial-credit)
  - [judge() -- LLM Rubric](#judge----llm-rubric)
  - [toolUsage() -- Tool Event Matching](#toolusage----tool-event-matching)
  - [The evaluate() Function](#the-evaluate-function)
  - [ScorerContext](#scorercontext)
  - [Fail-Fast Behavior](#fail-fast-behavior)
- [Conversations](#conversations)
  - [startChat() -- Imperative Multi-Turn](#startchat----imperative-multi-turn)
  - [runConversation() -- Declarative Multi-Turn](#runconversation----declarative-multi-turn)
  - [Completion Conditions](#completion-conditions)
  - [Reactions](#reactions)
  - [Personas](#personas)
  - [Step Scorers](#step-scorers)
  - [Replay Mode and Reaction Preview](#replay-mode-and-reaction-preview)
- [MCP Support](#mcp-support)
  - [Real MCP Configs](#real-mcp-configs)
  - [Mock MCP Servers](#mock-mcp-servers)
- [Agents](#agents)
  - [Claude SDK driver](#claude-sdk-driver)
- [CLI Reference](#cli-reference)
- [Vitest Plugin Configuration](#vitest-plugin-configuration)
- [EvalRuntime and LLM Injection](#evalruntime-and-llm-injection)
- [Environment Variables](#environment-variables)
- [Reviewing Results](#reviewing-results)
- [CI Integration](#ci-integration)
- [Affected Selection](#affected-selection)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Installation

**Prerequisites**: Node.js 20+, vitest 4+

```bash
npm i @wix/pathgrade vitest
```

### Per-agent runtime requirements

- **Claude**: pathgrade pulls in `@anthropic-ai/claude-agent-sdk`, which ships a per-platform `claude` binary as an optional npm dependency. With a normal `npm install` (or `yarn install`), the bundled binary is fetched automatically — you do not need a separate Claude CLI install. **Footprint:** the bundled binary adds tens of megabytes to `node_modules` (a per-platform binary plus the SDK runtime). If you already have a Claude CLI installed and want to avoid the duplicate footprint, you can either:
  - skip the optional dependency at install time (e.g. `npm install --no-optional` / `yarn install --ignore-optional`), and
  - point pathgrade at your local binary via `AgentOptions.claudeCodeExecutable: '/abs/path/to/claude'` or the `PATHGRADE_CLAUDE_CODE_EXECUTABLE` env var.

  See [Claude SDK driver](#claude-sdk-driver) for the full override precedence.
- **Codex**: install the Codex CLI per OpenAI's documentation; pathgrade shells out to it.
- **Cursor**: install `cursor-agent` per Cursor's documentation; pathgrade shells out to it.

## Quick Start

1. Create a `vitest.config.ts` with the pathgrade plugin:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { pathgrade } from '@wix/pathgrade/plugin';

export default defineConfig({
    plugins: [pathgrade({
        timeout: 120,
    })],
});
```

2. Write an eval file (e.g., `fix-bug.eval.ts`):

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { createAgent, check, evaluate } from '@wix/pathgrade';

describe('fix the bug', () => {
    it('agent fixes add() to return correct result', async () => {
        const agent = await createAgent({
            agent: 'claude',
            timeout: 120,
            workspace: 'fixtures',
        });

        await agent.prompt(
            'Read app.js, find the bug, and fix it so add(2, 3) returns 5.',
        );

        const result = await evaluate(agent, [
            check('file-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'app.js')),
            ),
            check('add-works', async ({ runCommand }) => {
                const { stdout } = await runCommand('node -e "console.log(require(\'./app.js\').add(2,3))"');
                return stdout.trim() === '5';
            }),
        ]);

        expect(result.score).toBeGreaterThanOrEqual(0.5);
    });
});
```

3. Run the eval:

```bash
npx vitest run
```

The pathgrade plugin auto-discovers `*.eval.ts` files, sets up workspace isolation, and reports aggregate pass rates after the run.

## How It Works

Pathgrade runs each evaluation through a pipeline:

1. **Create agent**: `createAgent()` provisions an isolated workspace with its own cwd, HOME, and temp directory.
2. **Stage files**: Workspace entries, skill files, and MCP configs are copied into the agent workspace.
3. **Run agent**: `prompt()`, `startChat()`, or `runConversation()` spawns the agent CLI (Claude or Codex) in the isolated workspace.
4. **Eval results**: `evaluate()` runs your scorers against the agent's workspace, transcript, log, and tool events.
5. **Report**: The pathgrade vitest reporter aggregates scores and computes pass rate, pass@k, and pass^k.

Each agent gets its own directory tree so agents don't share state between runs. Isolation is convention-based (separate HOME, TMPDIR, and cwd) rather than a hard sandbox. Authentication credentials are resolved automatically: on macOS, Claude OAuth tokens are extracted from the Keychain; Codex uses `codex login --with-api-key` when `OPENAI_API_KEY` is available.

## Writing Evals

### File Structure

Eval files are vitest test files named `*.eval.ts`. They use standard vitest constructs (`describe`, `it`, `expect`) combined with pathgrade's API:

```typescript
import { describe, it, expect } from 'vitest';
import { createAgent, evaluate, check, score, judge, toolUsage } from '@wix/pathgrade';
```

All test API functions are imported from `@wix/pathgrade`. The vitest plugin is imported from `@wix/pathgrade/plugin`. MCP mocks are imported from `@wix/pathgrade/mcp-mock`.

### createAgent

`createAgent()` sets up an isolated workspace and returns a `Agent` object. The agent is not started until you call `prompt()`, `startChat()`, or `runConversation()`.

```typescript
const agent = await createAgent({
    agent: 'claude',            // 'claude' | 'codex' (default: 'claude')
    timeout: 'auto',            // seconds or 'auto' (runConversation() only)
    workspace: 'fixtures',      // fixture directory to copy into workspace (optional)
    skillDir: './my-skill',     // path to skill directory (optional)
    copyIgnore: ['coverage'],   // replace default staging filters
    mcpMock: mockServer,        // mock MCP server descriptor (optional)
    debug: true,                // preserve workspace and emit run-snapshot.json
});
```

**AgentOptions**:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent` | `'claude' \| 'codex'` | `'claude'` | Agent CLI to use. Can be overridden via `PATHGRADE_AGENT` env var. |
| `timeout` | `number \| 'auto'` | `300` | Seconds before the agent times out. `'auto'` is supported for `runConversation()` only. |
| `workspace` | `string` | -- | Path to a fixture directory whose contents are copied into the agent workspace |
| `skillDir` | `string` | -- | Path to a skill directory to stage into both `.claude/skills/<name>/` and `.agents/skills/<name>/` so either path convention resolves |
| `copyFromHome` | `string[]` | -- | Relative paths to copy from real HOME into sandbox HOME |
| `copyIgnore` | `string[]` | built-in ignore list | Replaces the default workspace and skill copy ignore list. Pass `[]` to disable configurable filtering. |
| `env` | `Record<string, string>` | -- | Extra environment variables to inject into the agent environment |
| `mcpMock` | `MockMcpServerDescriptor \| MockMcpServerDescriptor[]` | -- | Mock MCP server(s) (Claude only) |
| `conversationWindow` | `ConversationWindowConfig \| false` | agent default | Configure transcript summarization for long conversations |
| `debug` | `boolean \| string` | -- | Preserve the workspace and emit `run-snapshot.json` under `pathgrade-debug/` or a custom directory |

**Agent interface**:

| Member | Type | Description |
|--------|------|-------------|
| `prompt(message)` | `(string) => Promise<string>` | One-shot: send a message, get the agent's response |
| `startChat(firstMessage)` | `(string) => Promise<ChatSession>` | Start an imperative multi-turn conversation |
| `runConversation(opts)` | `(ConverseOptions) => Promise<ConversationResult>` | Run a declarative multi-turn conversation |
| `exec(cmd)` | `(string) => Promise<CommandResult>` | Run a shell command in the workspace |
| `transcript()` | `() => string` | Get the full conversation as formatted text |
| `messages` | `Message[]` | Array of `{ role, content }` messages |
| `log` | `LogEntry[]` | Structured log entries (agent starts, commands, tool events) |
| `workspace` | `string` | Absolute path to the agent workspace |
| `dispose()` | `() => Promise<void>` | Clean up the workspace (automatic when using the plugin) |

An agent supports only one interaction method. Calling `startChat()` after `prompt()` (or any other mix) throws an error.

### Workspace Setup

The `workspace` field copies the contents of a fixture directory into the agent workspace:

```typescript
workspace: 'fixtures',   // copies contents of ./fixtures/ into the workspace root
```

The path is resolved relative to the caller's working directory. The entire directory tree is recursively copied into the agent's workspace root.

Workspace and skill staging ignore common junk by default, including `node_modules/`, `.git/`, `dist/`, `.DS_Store`, and Python cache directories. The default list is exported as `DEFAULT_COPY_IGNORE`.

For additional environment setup, use the `copyFromHome` and `env` fields:

```typescript
const agent = await createAgent({
    agent: 'claude',
    workspace: 'fixtures',
    copyFromHome: ['.npmrc'],           // copy ~/.npmrc into sandbox HOME
    env: { NODE_ENV: 'test' },          // inject extra env vars
});
```

Override the staging filters with `copyIgnore`:

```typescript
import { createAgent, DEFAULT_COPY_IGNORE } from '@wix/pathgrade';

const agent = await createAgent({
    workspace: 'fixtures',
    copyIgnore: [...DEFAULT_COPY_IGNORE, 'coverage'],
});
```

`copyIgnore` replaces the default list entirely. Pass `copyIgnore: []` to disable configurable filtering. `copyFromHome` is never filtered by `copyIgnore`, and staged skill directories still exclude `test/`.

### Instruction Tasks

The simplest eval pattern is a one-shot instruction where the agent receives a single prompt and executes:

```typescript
it('creates the config file', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 120 });

    const response = await agent.prompt(
        'Create a tsconfig.json with strict mode enabled.',
    );

    expect(response).toBeTruthy();

    const result = await evaluate(agent, [
        check('tsconfig-exists', ({ workspace }) =>
            fs.existsSync(path.join(workspace, 'tsconfig.json')),
        ),
        check('strict-enabled', async ({ runCommand }) => {
            const { stdout } = await runCommand('node -e "console.log(require(\'./tsconfig.json\').compilerOptions.strict)"');
            return stdout.trim() === 'true';
        }),
    ]);

    expect(result.score).toBeGreaterThanOrEqual(0.5);
});
```

## Scorers

Scorers evaluate what the agent did. Each scorer has a `name`, a `type`, and a `weight`. The `evaluate()` function runs all scorers and computes a weighted average score between 0.0 and 1.0.

### check() -- Boolean Gates

A check scorer is a pass/fail gate. It scores 1.0 if the function returns `true`, 0.0 otherwise.

```typescript
import { check } from '@wix/pathgrade';

check('output-file-exists', ({ workspace }) =>
    fs.existsSync(path.join(workspace, 'output.txt')),
);

check('tests-pass', async ({ runCommand }) => {
    const { exitCode } = await runCommand('npm test');
    return exitCode === 0;
}, { weight: 2 });
```

**Signature**: `check(name, fn, opts?) => CheckScorer`

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Human-readable scorer name |
| `fn` | `(ctx: ScorerContext) => boolean \| Promise<boolean>` | Returns true for pass, false for fail |
| `opts.weight` | `number` | Weight in the grade aggregate (default: 1) |

### score() -- Partial Credit

A score scorer returns a number between 0.0 and 1.0, or an object with `{ score, details? }` for partial credit (`details` is optional).

```typescript
import { score } from '@wix/pathgrade';

score('test-coverage', async ({ runCommand }) => {
    const { stdout } = await runCommand('npx coverage-summary');
    const pct = parseFloat(stdout);
    return pct / 100;  // 0.0 to 1.0
});

score('code-quality', async ({ runCommand }) => {
    const { stdout } = await runCommand('npx lint-check --json');
    const issues = JSON.parse(stdout).length;
    return {
        score: Math.max(0, 1 - issues * 0.1),
        details: `${issues} lint issues found`,
    };
}, { weight: 0.5 });
```

**Signature**: `score(name, fn, opts?) => ScoreScorer`

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Human-readable scorer name |
| `fn` | `(ctx: ScorerContext) => number \| ScoreResult \| Promise<...>` | Returns score (0-1) or `{ score, details? }` (`details` is optional) |
| `opts.weight` | `number` | Weight in the grade aggregate (default: 1) |

### judge() -- LLM Rubric

A judge scorer sends the agent transcript to an LLM and evaluates it against a rubric. The transcript is automatically included.

```typescript
import { judge } from '@wix/pathgrade';

judge('workflow-quality', {
    rubric: `Evaluate the agent's workflow:
- Did it read the file before editing? (0-0.5)
- Was the fix minimal and correct? (0-0.5)`,
    weight: 0.3,
    retry: true,
});

judge('conversation-quality', {
    rubric: 'Did the agent communicate clearly and stay on topic?',
    model: 'claude-sonnet-4-20250514',
    includeToolEvents: true,
    input: {
        'Expected Outcome': 'The agent should have created a project brief.',
    },
});
```

**Signature**: `judge(name, opts) => JudgeScorer`

| Option | Type | Description |
|--------|------|-------------|
| `rubric` | `string` | Evaluation criteria for the LLM judge |
| `weight` | `number` | Weight in the grade aggregate (default: 1) |
| `model` | `string` | LLM model override (default: auto-detected from available keys/CLI) |
| `retry` | `boolean \| number` | Retry transient judge failures. `true` uses the default retry budget; a number sets the retry count explicitly. |
| `includeToolEvents` | `boolean` | Include normalized tool events in the context sent to the judge |
| `input` | `Record<string, unknown>` | Additional key-value context sections appended to the judge prompt |
| `tools` | `CodeJudgeToolName[]` | Opt into a bounded multi-turn tool-use loop. The judge LLM can call `readFile`, `listDir`, `grep`, `getToolEvents`. See below. |
| `maxRounds` | `number` | Cap on LLM calls per tool-using judge (default 10). |
| `cacheControl` | `boolean` | Enable Anthropic prompt caching on the system prompt and tool schemas. Default: `true` when `tools` is set, otherwise unchanged. |

#### Tool-using judges — `judge({ tools })`

When a rubric's grade depends on **what the agent actually produced** — the contents of a file, whether a spec has certain sections, the number of FR entries, etc. — setting `tools` lets the judge LLM gather that evidence itself instead of the eval author pre-computing it.

```typescript
judge('spec-structure', {
    rubric: `Read artifacts/spec.md. Score 1.0 if it has Intent Hierarchy,
             Functional Requirements, and API Surface sections. 0.33 each.`,
    tools: ['readFile'],
    model: 'claude-haiku-4-5-20251001',
});
```

**Available tools** (v1):

| Tool | Purpose |
|------|---------|
| `readFile` | Read a workspace-relative file. Content truncated at 200KB. |
| `listDir` | One level of directory entries (directory names get a trailing `/`). |
| `grep` | Regex search across workspace files. Returns `path:line:text`. Caps at 50 matches / 300-char lines. Dotfiles and `node_modules` excluded. |
| `getToolEvents` | JSON of agent tool events, with optional `actionFilter` substring. Automatically enables `includeToolEvents` when listed. |

**Security**: every tool runs inside a workspace-root containment check (`realpath` on parent + basename, rejecting escapes via `..` or symlinks). No `runCommand`, no network, no code sandbox. Tools execute on the host at the scorer's existing trust level.

**Failure codes** — tool-using judges report distinct errors via the `errorCode` field on the scorer result:

- `llm_refused` — judge produced empty response, no tool call. Retries if configured.
- `max_rounds` — loop hit `maxRounds`. Not retried (same input would repeat). Error message includes the current cap.
- `invalid_score` — final JSON missing `score`, or out of `[0, 1]`. Retries if configured.
- `tool_error_unrecoverable` — unknown tool requested, workspace missing, or provider threw (rate limit, 500, context length).
- `provider_not_supported` — active provider doesn't implement `callWithTools`. Set `ANTHROPIC_API_KEY` or remove `tools`.

**Provider support**: Anthropic HTTP provider only in v1. Using `tools` with `agent: 'codex'` or a setup without Anthropic access produces a clean `provider_not_supported` error.

### Choosing a scorer

| When the rubric… | Use |
|------------------|-----|
| can be expressed as a deterministic check (file exists, contents match) | `check()` |
| is prose/narrative quality and the transcript is sufficient evidence | `judge()` (no `tools`) |
| requires reading workspace artifacts or cross-referencing files | `judge({ tools: [...] })` |
| needs arbitrary code (shell commands, network, complex computation) | `score()` |

Rule of thumb: start with `check()` when you can. Reach for `judge()` only when the evidence needs prose interpretation. Add `tools` only when the judge can't grade from the transcript alone.

### Migrating from `input`-helper probes to `tools`

Before (two-source-of-truth pattern — the pain the feature motivates):

```typescript
// scorers/spec-sections.ts
export function missingSpecSections(workspace: string): string[] {
    const body = fs.readFileSync(path.join(workspace, 'artifacts/spec.md'), 'utf8');
    return ['Intent Hierarchy', 'Functional Requirements', 'API Surface']
        .filter((s) => !body.includes(`## ${s}`));
}

// eval.ts
judge('spec-sections', {
    rubric: 'Does the spec include every required section?',
    input: { missing_sections: missingSpecSections(workspace) },
});
```

After (single source of truth — judge reads the file):

```typescript
judge('spec-sections', {
    rubric: `Read artifacts/spec.md. Score 1.0 if it contains Intent Hierarchy,
             Functional Requirements, and API Surface sections. 0.33 per section.`,
    tools: ['readFile'],
});
```

Migration recipe:

1. Identify `input` keys that are derived purely from files the agent produced (e.g., `missing_sections`, `spec_body`, `api_names`).
2. Remove the helper function and the `input` entry.
3. Name the artifact paths explicitly in the rubric prose (e.g., "Read `artifacts/spec.md`").
4. Set `tools` to the smallest subset that covers the evidence: `['readFile']` for a single file, `['readFile', 'grep']` for cross-file patterns, add `'listDir'` when the file set itself is part of the criterion.
5. Keep `input` for things that can't be read from files (external API output, expected-value tables, etc.).

See `examples/tool-judge-demo/` for a runnable before/after.

**Observability**: every tool call appears in the trial's session log as a `judge_tool_call` entry with name, arguments, byte count, and ok/error. The browser reporter renders them as collapsible blocks under each trial; the CLI reporter shows a per-trial `N judge tool calls (readFile, grep)` summary line.

**Known limitations** (v1):

- OpenAI and Claude CLI providers do not implement `callWithTools`. If your agent environment uses those providers, tool-using judges produce a clean `provider_not_supported` error. Keep them vanilla or run your judges against Anthropic HTTP.

### toolUsage() -- Tool Event Matching

A tool usage scorer matches normalized agent tool events against declarative expectations.

```typescript
import { toolUsage } from '@wix/pathgrade';

toolUsage('expected-tool-calls', [
    { action: 'read_file', min: 1, weight: 0.3 },
    { action: 'edit_file', min: 1, weight: 0.3 },
    { action: 'run_shell', commandContains: 'test', min: 1, weight: 0.4 },
]);
```

**Signature**: `toolUsage(name, expectations, opts?) => ToolUsageScorer`

**Normalized actions**: `run_shell`, `read_file`, `write_file`, `edit_file`, `search_code`, `list_files`, `ask_user`, `web_fetch`, `unknown`.

**Expectation filters**:

| Filter | Type | Description |
|--------|------|-------------|
| `action` | `ToolAction` | Normalized action name (required) |
| `min` | `number` | Minimum occurrences (default: 1) |
| `max` | `number` | Maximum occurrences |
| `path` | `string` | Match events with this file path |
| `commandContains` | `string` | Match shell commands containing this substring |
| `argumentPattern` | `string` | Regex tested against all string argument values |
| `toolName` | `string` | Match the provider-specific tool name |
| `weight` | `number` | Weight of this expectation within the scorer (default: 1) |

### The evaluate() Function

`evaluate()` runs an array of scorers against an agent and returns a `EvalResult`:

```typescript
import { evaluate } from '@wix/pathgrade';

const result = await evaluate(agent, [
    check('file-exists', ({ workspace }) => fs.existsSync(path.join(workspace, 'out.txt'))),
    score('quality', async ({ runCommand }) => { /* ... */ }),
    judge('workflow', { rubric: '...' }),
    toolUsage('tools', [{ action: 'read_file', min: 1 }]),
], {
    failFast: true,
    onScorerError: 'skip',
});

// result.score: weighted average (0.0 to 1.0)
// result.scorers: per-scorer breakdown
```

**EvalResult**:

```typescript
interface EvalResult {
    score: number;            // weighted average of all scorer scores
    scorers: ScorerResultEntry[];
    tokenUsage?: TokenUsage;
}

interface ScorerResultEntry {
    name: string;
    type: 'check' | 'score' | 'judge' | 'tool_usage';
    score: number;            // 0.0 to 1.0
    weight: number;
    details?: string;
    status?: 'ok' | 'error' | 'skipped';
}
```

**EvaluateOptions**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `failFast` | `boolean` | `true` | Skip judge and tool-usage scorers after a failed `check()` scorer |
| `onScorerError` | `'skip' \| 'zero' \| 'fail'` | `'skip'` | Control whether errored scorers are excluded from aggregation, counted as zero, or cause `evaluate()` to throw `EvalScorerError` after the run |

Errored scorers are surfaced separately from low scores via `status: 'error'`.

### ScorerContext

Every scorer function (`check`, `score`) receives a `ScorerContext`:

| Field | Type | Description |
|-------|------|-------------|
| `workspace` | `string` | Absolute path to the agent workspace |
| `log` | `LogEntry[]` | Structured log: agent starts, commands, tool events |
| `transcript` | `string` | Formatted conversation text (`[User]...\n[Agent]...`) |
| `toolEvents` | `ToolEvent[]` | Normalized tool events extracted from agent output |
| `runCommand` | `(cmd: string) => Promise<CommandResult>` | Execute a shell command in the workspace |

**ToolEvent** fields:

| Field | Type | Description |
|-------|------|-------------|
| `action` | `ToolAction` | Normalized action (`read_file`, `run_shell`, etc.) |
| `provider` | `'claude' \| 'codex'` | Which agent produced this event |
| `providerToolName` | `string` | The provider-specific tool name |
| `turnNumber` | `number?` | Conversation turn that produced this event |
| `arguments` | `Record<string, unknown>?` | Tool call arguments |
| `summary` | `string` | Human-readable summary |
| `confidence` | `'high' \| 'medium' \| 'low'` | Extraction confidence |
| `rawSnippet` | `string` | Raw trace snippet (first 200 chars) |

### Fail-Fast Behavior

By default, `evaluate()` uses fail-fast: if any `check` scorer scores 0, the remaining `judge` and `toolUsage` scorers are skipped (marked as score 0 with details "skipped (fail-fast)"). This saves LLM calls when basic preconditions fail.

Scorers run in three phases:
1. `check` + `score` scorers (parallel)
2. `judge` scorers (parallel, skipped on fail-fast)
3. `toolUsage` scorers (parallel, skipped on fail-fast)

Note that a `score()` returning 0 does **not** trigger fail-fast -- only `check()` failures do.

Disable fail-fast when you want all scorers to run regardless:

```typescript
const result = await evaluate(agent, scorers, { failFast: false });
```

## Conversations

Pathgrade supports two styles of multi-turn conversation: **imperative** (`startChat()`) and **declarative** (`runConversation()`).

### startChat() -- Imperative Multi-Turn

`startChat()` gives you full control over the conversation loop. You send messages one at a time and decide when to stop:

```typescript
it('guides the agent through a multi-step task', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 300 });

    const chat = await agent.startChat('I want to set up a new TypeScript project.');

    // chat.lastMessage has the agent's first response
    expect(chat.lastMessage).toBeTruthy();
    expect(chat.turn).toBe(1);

    // Send follow-up messages
    await chat.reply('Use strict mode and add eslint.');
    expect(chat.turn).toBe(2);

    // Check workspace state mid-conversation
    if (await chat.hasFile('tsconfig.json')) {
        await chat.reply('Now add a build script to package.json.');
    }

    // End the conversation when done
    chat.end();

    const result = await evaluate(agent, [
        check('tsconfig', ({ workspace }) =>
            fs.existsSync(path.join(workspace, 'tsconfig.json')),
        ),
    ]);

    expect(result.score).toBeGreaterThanOrEqual(0.5);
});
```

**ChatSession interface**:

| Member | Type | Description |
|--------|------|-------------|
| `turn` | `number` | Current turn number (1 after first message) |
| `done` | `boolean` | Whether the session has ended |
| `lastMessage` | `string` | The agent's most recent response |
| `messages` | `Message[]` | Full conversation history |
| `reply(message)` | `(string) => Promise<void>` | Send a follow-up message to the agent |
| `hasFile(glob)` | `(string) => Promise<boolean>` | Check if a file exists in the workspace |
| `end()` | `() => void` | Mark the session as done |

### runConversation() -- Declarative Multi-Turn

`runConversation()` runs a conversation loop automatically using reactions, personas, and completion conditions:

If an agent turn contains blocked interactive prompts, Pathgrade surfaces the first blocked prompt as the visible assistant turn, replays any remaining blocked prompts locally in order, and only resumes model execution after the queue is exhausted. Reactions, personas, transcripts, and snapshots all operate on that visible blocked prompt text rather than on hidden completion prose from the same raw turn.

```typescript
it('completes a guided conversation', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 600 });

    const result = await agent.runConversation({
        firstMessage: 'I want to create a new feature for the stores platform.',
        maxTurns: 12,
        until: async ({ hasFile }) => await hasFile('project-brief.md'),
        reactions: [
            { when: /goal|trying to achieve/i, reply: 'Solve a user pain point' },
            { when: /artifact available/i, unless: /no artifact available/i, reply: 'Use the artifact please.' },
            { when: /target|audience/i, reply: 'Self-Creator' },
        ],
        persona: {
            description: 'You are a product manager who communicates concisely.',
            facts: [
                'The feature is for online stores',
                'Target users are store owners',
            ],
        },
    });

    expect(result.completionReason).toBe('until');
    expect(result.turns).toBeLessThanOrEqual(12);

    const evalResult = await evaluate(agent, [
        check('brief-created', ({ workspace }) =>
            fs.existsSync(path.join(workspace, 'project-brief.md')),
        ),
        judge('brief-quality', {
            rubric: 'Is the project brief well-structured and complete?',
        }),
    ]);

    expect(evalResult.score).toBeGreaterThanOrEqual(0.5);
});
```

**ConverseOptions**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `firstMessage` | `string` | (required) | First message to send to the agent |
| `maxTurns` | `number` | `30` | Hard limit on underlying model turns; synthetic blocked-prompt replays do not consume it |
| `until` | `UntilPredicate` | -- | Async predicate checked after each model turn; it is deferred while a blocked-prompt queue is still pending |
| `reactions` | `Reaction[]` | `[]` | Regex-based scripted replies |
| `persona` | `PersonaConfig` | -- | LLM-simulated conversation partner |
| `stepScorers` | `StepScorer[]` | `[]` | Run scorers at specific turn numbers |

**ConversationResult**:

| Field | Type | Description |
|-------|------|-------------|
| `turns` | `number` | Total underlying model turns completed |
| `completionReason` | `'until' \| 'maxTurns' \| 'noReply' \| 'timeout' \| 'error'` | Why the conversation ended |
| `completionDetail` | `string?` | Additional context about completion (e.g., error message) |
| `turnTimings` | `TurnTiming[]` | Per-model-turn duration measurements |
| `turnDetails` | `TurnDetail[]?` | Per-model-turn duration and output-size details used by diagnostics |
| `reactionsFired` | `ReactionFiredEntry[]?` | The reactions that actually fired during the conversation |
| `stepResults` | `Array<{ afterTurn, result }>` | Results from step scorers |

### Completion Conditions

A `runConversation()` conversation ends when any of these triggers fire (checked in order):

1. **`until` predicate**: A function that receives context and returns `true` to stop.
2. **`maxTurns`**: Hard cap on the number of turns.
3. **No reply**: No reaction matched and no persona is configured.
4. **Timeout**: The agent's total time budget is exhausted.
5. **Error**: An unrecoverable error occurred during a turn (after retries).

Blocked prompt queues pause normal completion checks: queued prompts are replayed locally first, then `until` and `maxTurns` resume once the queue is empty.

The `until` predicate receives an `UntilContext`:

```typescript
interface UntilContext {
    turn: number;
    lastMessage: string;
    workspace: string;
    messages: Message[];
    hasFile: (glob: string) => Promise<boolean>;
}
```

Example combining file detection with turn-based conditions:

```typescript
until: async ({ turn, hasFile, lastMessage }) => {
    if (turn >= 3 && await hasFile('output.md')) return true;
    if (/COMPLETE|DONE/i.test(lastMessage)) return true;
    return false;
},
```

### Reactions

Reactions are scripted regex-based replies. The first eligible reaction wins:

```typescript
reactions: [
    { when: /goal|trying to achieve/i, reply: 'Solve a user pain point' },
    { when: /artifact available/i, unless: /no artifact available/i, reply: 'Please use the artifact.' },
    { when: /target|audience/i, reply: 'Self-Creator' },
    { when: /confirm|sound right/i, reply: 'Yes, that is correct.' },

    // Catch-all (consumed after first match)
    { when: /.*/, reply: 'The feature is for online stores.', once: true },
]
```

| Field | Type | Description |
|-------|------|-------------|
| `when` | `RegExp` | Regex tested against the agent's latest message |
| `unless` | `RegExp?` | Optional veto guard. If both `when` and `unless` match, the reaction does not fire. |
| `reply` | `string` | The response to send |
| `once` | `boolean?` | If true, this reaction is consumed after first use |

Reactions are evaluated in order. `unless` vetoes do not consume `once`, so the same reaction can still fire on a later turn. If no reaction matches and no persona is configured, the conversation ends with `noReply`.

When blocked prompts are active, reactions inspect only the currently visible blocked prompt text. Hidden completion summaries from the same raw turn are preserved for diagnostics but do not participate in matching.

### Personas

Personas are LLM-simulated conversation partners that respond naturally based on a character description and facts:

```typescript
persona: {
    description: `You are a product manager at Acme who has worked on the Stores
platform for 2 years. You communicate directly and concisely.`,
    facts: [
        'The feature is for the Acme Stores platform',
        'Target users are Self-Creators',
        'Goal: solve user pain point',
    ],
    model: 'claude-sonnet-4-20250514',  // optional model override
}
```

When both reactions and a persona are configured, reactions are tried first. If no reaction matches, the persona generates a reply. This lets you combine scripted responses for predictable questions with natural LLM-generated responses for unexpected ones.

You can also create a persona object directly using `createPersona()`:

```typescript
import { createPersona } from '@wix/pathgrade';

const pm = createPersona({
    description: 'You are a concise product manager.',
    facts: ['The project is about stores'],
});

// pm.reply(chatSession) generates a response
```

### Step Scorers

Step scorers run at specific points during a `runConversation()` conversation, letting you assert on intermediate state:

```typescript
await agent.runConversation({
    firstMessage: 'Build a REST API with tests.',
    maxTurns: 10,
    stepScorers: [
        {
            afterTurn: 3,
            scorers: [
                check('routes-exist', ({ workspace }) =>
                    fs.existsSync(path.join(workspace, 'routes.ts')),
                ),
            ],
        },
        {
            afterTurn: 6,
            scorers: [
                check('tests-exist', ({ workspace }) =>
                    fs.existsSync(path.join(workspace, 'routes.test.ts')),
                ),
            ],
        },
    ],
});
```

Step scorer results are included in the `ConversationResult.stepResults` array.

### Replay Mode and Reaction Preview

Set `debug: true` or a custom debug path on `createAgent()` to preserve the workspace and emit a structured `run-snapshot.json` file after a conversation run. You can then replay scorers offline with `evaluate.fromSnapshot()`:

```typescript
const replayed = await evaluate.fromSnapshot(
    './pathgrade-debug/my-run/run-snapshot.json',
    [
        check('mentions fix', ({ transcript }) => transcript.includes('fix')),
    ],
    { onScorerError: 'skip' },
);
```

You can also preview reaction matching against a saved snapshot:

```bash
pathgrade preview-reactions \
  --snapshot ./pathgrade-debug/my-run/run-snapshot.json \
  --reactions ./reactions.ts \
  --format json
```

The preview output reports each agent turn and whether each reaction fired, was vetoed, or did not match.

When blocked prompts are involved, snapshots continue to show the visible assistant prompt in `messages`, while log entries also preserve `assistant_message_source`, `raw_assistant_message`, and blocked-prompt provenance so you can audit which prompt was surfaced and what raw completion text was hidden behind it.

## MCP Support

### Real MCP Configs

Real MCP server configuration pass-through is supported internally but is **not yet exposed** through the `AgentOptions` public API. Currently, only mock MCP servers are available via the `mcpMock` option.

### Mock MCP Servers

Create fake MCP servers with predefined responses. Mock servers work with Claude only (`AGENT_CAPABILITIES` records `codex.mcp === false`):

```typescript
import { mockMcpServer } from '@wix/pathgrade/mcp-mock';

const kbMock = mockMcpServer({
    name: 'kb-retrieval',
    tools: [
        {
            name: 'retrieve_documents',
            description: 'Retrieve documents from the knowledge base',
            when: 'knowledge_base_id.*abc123',  // regex filter on arguments
            response: {
                documents: [
                    { title: 'API Guide', content: '...' },
                ],
            },
        },
    ],
});

const agent = await createAgent({
    agent: 'claude',
    mcpMock: kbMock,       // single mock
    // mcpMock: [kbMock, otherMock],  // or an array of mocks
});
```

**MockMcpTool** fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name exposed to the agent |
| `description` | `string?` | Tool description |
| `inputSchema` | `Record<string, unknown>?` | JSON Schema for tool input |
| `when` | `string?` | Regex filter on stringified arguments; if omitted, always matches |
| `response` | `unknown` | The response object returned when the tool is called |

## Agents

Pathgrade supports three agent runtimes:

| Agent | Runtime | MCP Support | Auth |
|-------|---------|-------------|------|
| **Claude** | `@anthropic-ai/claude-agent-sdk` (bundled binary) | Real + Mock | Keychain OAuth (macOS), API key, or other SDK auth env vars |
| **Codex** | `codex` CLI | None | Cached CLI login or API key |
| **Cursor** | `cursor-agent` CLI | None | Keychain OAuth (macOS) or `CURSOR_API_KEY` |

**Agent selection**: The `agent` field in `AgentOptions` determines which runtime to use. The `PATHGRADE_AGENT` environment variable overrides this at runtime, letting you run the same eval file against different agents without editing code.

**Auth**: All agents get a fresh isolated HOME directory. Authentication is resolved automatically:
- **Claude**: On macOS, extracts OAuth credentials from the system Keychain. Falls back to `ANTHROPIC_API_KEY`. See [Claude SDK driver](#claude-sdk-driver) below for the full SDK auth env var allowlist (including Bedrock, Vertex, Foundry).
- **Codex**: When `OPENAI_API_KEY` is available, runs `codex login --with-api-key` in the sandbox before the first turn. Otherwise, if the host machine already has a file-based Codex login cache at `~/.codex/auth.json`, Pathgrade copies that cache into the isolated HOME and reuses it.
- **Cursor**: forwards `CURSOR_API_KEY` when set; on macOS, reuses `cursor-agent login` OAuth tokens from the login Keychain.

### Claude SDK driver

The Claude agent driver runs Claude through the `@anthropic-ai/claude-agent-sdk` rather than scraping the `claude` CLI's stream-JSON output. This unlocks the real `AskUserQuestion` handshake — Pathgrade reactions can deliver answers back to Claude as a real tool result mid-turn, instead of being reconstructed from denied prompts after the fact.

A few pathgrade behaviors follow from this choice and are worth knowing when authoring fixtures or running evals.

#### `AskUserQuestion` is unavailable inside subagents

The Claude Agent SDK does not expose `AskUserQuestion` to subagents spawned through the `Task` tool. If your fixture or skill spawns a subagent and that subagent tries to ask the user a question, the SDK will not surface that question to pathgrade's `canUseTool` callback, so no `AskUserReaction` can fire for it. Author fixtures that rely on the structured ask-user handshake at the top-level agent — not from inside a subagent.

#### Claude binary: bundled by default, overridable

The SDK ships a per-platform `claude` binary as an optional npm dependency, so by default pathgrade uses that pinned binary regardless of which Claude CLI version is installed on the host. This protects CI from "today's green eval is red tomorrow because someone updated their local Claude" drift.

If you want Pathgrade to run a specific local Claude build instead (for example, an in-development build under test), supply an override path. Precedence is:

1. `AgentOptions.claudeCodeExecutable` — passed to `createAgent({ agent: 'claude', claudeCodeExecutable: '/abs/path/to/claude' })`.
2. `PATHGRADE_CLAUDE_CODE_EXECUTABLE` — process env, picked up at agent construction.
3. The SDK's bundled binary — used when neither override is set.

The override is intentionally run-level. There is no fixture-file-level API for selecting different Claude binaries per trial.

#### Claude Code system-prompt preset

Pathgrade configures the SDK with `systemPrompt: { type: 'preset', preset: 'claude_code' }`. This is required because the SDK's default prompt is intentionally minimal and does not include the full Claude Code coding guidelines, response style, safety instructions, or environment context. Pathgrade evaluates skills under the same core prompt contract Claude Code users get, not the SDK's bare default. Pathgrade does not currently expose a fixture-level knob to replace the system prompt; if you need to evaluate a specific prompt variant, that is a future feature.

#### Hermetic vs. CLI-faithful settings

By default, Pathgrade runs Claude in a **hermetic** profile: `settingSources: ['project']`, with `CLAUDE_CONFIG_DIR` pointed at a per-trial scratch directory under the workspace and auto-memory excluded by virtue of not loading the user scope. This means:

- Skills staged under `<workspace>/.claude/skills/<name>/SKILL.md` are auto-discovered.
- Project-level rules, hooks, settings, slash commands, and `CLAUDE.md` from the prepared workspace load.
- The host machine's `~/.claude.json`, user-level skills, user-level hooks, and accumulated auto-memory **do not** load.

If you instead want CLI-faithful evaluation (skills, hooks, settings, and memory exactly as your local CLI sees them), opt in via the `settingSources: ['user', 'project', 'local']` Claude SDK option. This is **non-hermetic**: results can vary across machines because user-level skills and accumulated memory differ. Use it when you are explicitly evaluating local-machine behavior, not for CI matrices that need to be reproducible. (Pathgrade does not currently surface the override at the `createAgent` level; it is a documented option pathway for downstream consumers configuring the SDK directly.)

#### SDK auth environment variables

The Claude SDK driver can authenticate through any of the following env surfaces. Set whichever matches your environment; Pathgrade forwards them through the sandbox-exec env filter:

| Variable | When to use |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Default API-key auth. The most common CI pattern. |
| `ANTHROPIC_AUTH_TOKEN` | OAuth-style token auth. |
| `ANTHROPIC_BASE_URL` | Custom Anthropic API endpoint (e.g. enterprise proxy). Pair with the matching key/token. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (alternative to keychain-extracted OAuth on macOS). |
| `AWS_*` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, etc.), `ANTHROPIC_BEDROCK_BASE_URL` | Bedrock-hosted Claude. |
| `GOOGLE_*`, `GCLOUD_*`, `CLOUD_ML_*`, `ANTHROPIC_VERTEX_BASE_URL` | Vertex AI-hosted Claude. |
| `AZURE_*`, `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry-hosted Claude. |

For local first-party use on macOS, your existing Claude Code keychain login still works — pathgrade extracts the OAuth credentials and forwards them as `ANTHROPIC_API_KEY`. For productized SDK use or anything running outside your developer machine, configure one of the explicit auth surfaces above. `apiKeyHelper` (a code callback) is intentionally out of scope; inject concrete env credentials instead.

## CLI Reference

Pathgrade ships a CLI that wraps vitest and provides convenience commands:

```bash
pathgrade run [-- vitest-args]
```

Runs vitest with the pathgrade plugin. Pass `--diagnostics` before `--` to force full diagnostics for successful evals as well. Any arguments after `--` are forwarded to vitest (for example, `pathgrade run -- --grep conversation`).

```bash
pathgrade init [--force]
```

Generates example `.eval.ts` files in the current project. Use `--force` to overwrite existing files. Note: the generated scaffold may need manual adjustment to match the current API.

```bash
pathgrade preview [browser]
```

Displays cached results from the most recent run. Without arguments it prints a CLI summary table. Pass `browser` to open an interactive viewer in the default browser.

```bash
pathgrade preview-reactions --snapshot <path> --reactions <module-or-json-path> [--format cli|json]
```

Loads a saved `run-snapshot.json`, evaluates reactions against the stored agent messages, and prints either human-readable or machine-readable output.

```bash
pathgrade validate <file.eval.ts>
```

Validates an eval file for common authoring mistakes.

```bash
pathgrade --help
pathgrade --version
```

Print usage information or the installed version.

## Vitest Plugin Configuration

The `pathgrade()` plugin factory configures vitest for eval runs:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { pathgrade } from '@wix/pathgrade/plugin';

export default defineConfig({
    plugins: [pathgrade({
        include: ['evals/**/*.eval.ts'],  // default: ['**/*.eval.ts']
        timeout: 300,                      // default: 300 seconds
        reporter: 'cli',                   // 'cli' | 'browser' | 'json'
        diagnostics: false,                // force full diagnostics on successful runs
        scorerModel: 'claude-sonnet-4-20250514',
        ci: {
            threshold: 0.8,               // fail the run if avg score < threshold
        },
    })],
});
```

**PathgradePluginOptions**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `include` | `string[]` | `['**/*.eval.ts']` | Glob patterns for eval test files |
| `exclude` | `string[]` | vitest defaults + `['.worktrees/**', 'worktrees/**']` | Glob patterns to exclude from eval discovery. Replaces defaults entirely when provided. |
| `timeout` | `number` | `300` | Agent timeout in seconds. The vitest test timeout is set to `timeout + 30` to give scorers time to finish. |
| `reporter` | `'cli' \| 'browser' \| 'json'` | -- | How to display results. `cli` prints a summary table, `browser` opens an interactive viewer, `json` writes results to disk. |
| `diagnostics` | `boolean` | `false` | Force full diagnostics output for successful evals. Failures and timeouts already print full diagnostics automatically. |
| `scorerModel` | `string` | -- | Reserved for future use. Not yet wired -- judge scorers currently use their per-scorer `model` field. |
| `ci.threshold` | `number` | -- | When set, the process exits with code 1 if the average score is below this threshold |

The plugin automatically:
- Sets `test.include` to match eval files
- Sets `test.testTimeout` to accommodate agent + grading time
- Registers a setup file that auto-disposes agents after each test
- Adds the pathgrade reporter for aggregate statistics

## EvalRuntime and LLM Injection

For unit testing your scorers or running evals without real LLM calls, use `setRuntime()` to inject a fake LLM:

```typescript
import { setRuntime, resetRuntime } from '@wix/pathgrade';
import { afterEach } from 'vitest';

afterEach(() => {
    resetRuntime();
});

it('judge scorer scores correctly', async () => {
    // Inject a fake LLM that always returns a known response
    setRuntime({
        llm: {
            call: async () => ({
                text: '{"score": 0.75, "reasoning": "Good work"}',
                provider: 'anthropic',
                model: 'fake',
            }),
        },
    });

    const result = await evaluate(agent, [
        judge('quality', { rubric: 'Is the code clean?' }),
    ]);

    expect(result.score).toBe(0.75);
});
```

**EvalRuntime** interface:

| Field | Type | Description |
|-------|------|-------------|
| `llm` | `LLMPort` | The LLM backend used by judge scorers |
| `onResult` | `(result: EvalResult) => void` | Callback fired after `evaluate()` produces a result |

**LLMPort** interface:

```typescript
interface LLMPort {
    call(prompt: string, opts?: { model?: string }): Promise<LLMCallResult>;
}
```

`setRuntime()` accepts a partial: you can override just `llm`, just `onResult`, or both. `resetRuntime()` restores the default runtime that uses real API calls.

The pathgrade vitest plugin uses `setRuntime({ onResult })` internally to capture eval results and surface them in the reporter. You generally don't need to set `onResult` yourself unless building custom tooling.

## Environment Variables

| Variable | Used By |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude agent, judge scorers, persona replies |
| `ANTHROPIC_AUTH_TOKEN` | Claude agent (OAuth token alternative to API key) |
| `ANTHROPIC_BASE_URL` | Custom Anthropic API endpoint (passed through to sandbox) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude agent (Claude Code OAuth token) |
| `AWS_*`, `ANTHROPIC_BEDROCK_BASE_URL` | Claude agent on Bedrock |
| `GOOGLE_*`, `GCLOUD_*`, `CLOUD_ML_*`, `ANTHROPIC_VERTEX_BASE_URL` | Claude agent on Vertex |
| `AZURE_*`, `ANTHROPIC_FOUNDRY_BASE_URL` | Claude agent on Foundry |
| `OPENAI_API_KEY` | Codex agent, judge scorers (when using OpenAI models) |
| `OPENAI_BASE_URL` | Custom OpenAI API endpoint (passed through to sandbox) |
| `CURSOR_API_KEY` | Cursor agent (when not using keychain OAuth) |
| `PATHGRADE_AGENT` | Overrides `agent` in `AgentOptions` at runtime |
| `PATHGRADE_CLAUDE_CODE_EXECUTABLE` | Overrides the SDK's bundled Claude binary with a local path |
| `PATHGRADE_CODEX_TRANSPORT` | Overrides Codex transport (`app-server` \| `exec`) |

When the Claude CLI is installed and authenticated (or Keychain credentials are available on macOS), it is used as the primary LLM backend for judge scorers and persona replies -- no API key needed for local development.

## Reviewing Results

The pathgrade reporter prints an aggregate summary after vitest completes:

```
-- pathgrade summary ----------------------------------------

  my-evals/fix-bug.eval.ts > fix the bug
    pass rate    80.0%
    pass@5       99.9%
    pass^5       32.8%
    avg time     45.2s
    trials       5
```

**Metrics**:
- **pass rate**: Fraction of trials with score >= 0.5.
- **pass@k**: Probability of at least one success in k trials: `1 - (1-p)^k`.
- **pass^k**: Probability of all k trials succeeding: `p^k`.

Every run writes a consolidated `.pathgrade/results.json` (plus per-group trace files under `.pathgrade/traces/`) in the project directory. The directory is auto-gitignored on first write. Use `reporter: 'browser'` to open an interactive viewer after each run, or invoke `npx pathgrade preview` / `npx pathgrade preview browser` later. By default, successful evals print a one-line diagnostics summary, while failures and timeouts print the full diagnostics breakdown automatically. Set `diagnostics: true` in the plugin or pass `pathgrade run --diagnostics` to force full diagnostics on successful runs too.

## CI Integration

```yaml
# GitHub Actions example
jobs:
  eval:
    runs-on: ubuntu-latest
    # Required so GITHUB_TOKEN can post/update the pathgrade PR comment.
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22.10.0
          cache: yarn
      - run: corepack enable
      - run: NPQ_PKG_MGR=yarn npx npq install
      - name: Run pathgrade evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: yarn pathgrade run
      - name: Post PR report
        if: always()
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: yarn pathgrade report
      - name: Upload eval reports
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: pathgrade-reports
          path: .pathgrade/
```

`pathgrade report` reads `.pathgrade/results.json`, formats a markdown summary (overall pass rate, pass@k, pass^k, per-group summary table, collapsible per-trial scorer breakdown + diagnostics), and posts it as a PR comment when `GITHUB_TOKEN` + a PR context are available. On re-push it updates the existing comment in place via an HTML marker so the PR stays clean. The command is display-only — it always exits 0 even on GitHub API errors, and prints the pass rate as a plain number on the final line of stdout for downstream capture.

Set a CI threshold in the plugin config to fail the build when scores are too low:

```typescript
// vitest.config.ts
pathgrade({
    ci: { threshold: 0.8 },
})
```

This causes pathgrade to set `process.exitCode = 1` if the average score across all evals falls below 0.8. Threshold enforcement lives in the plugin config, not in `pathgrade report`.

For faster CI runs, split evals into separate vitest config files with different `include` patterns and agent counts. Pass `--comment-id=<id>` to `pathgrade report` so each workflow/job manages its own PR comment without overwriting the others.

## Affected Selection

Pathgrade evals are expensive — each trial spends real tokens. For PR CI,
you usually only want to rerun evals whose *dependencies* actually changed.
`pathgrade run --changed` does exactly that: it diffs the PR against the
base branch, figures out which evals are affected, and passes that file
list to vitest. Unaffected evals are skipped. Correctness comes first:
anything pathgrade can't positively classify as unaffected reruns.

### Happy path (zero config)

The common case is a skill-anchored eval: a `SKILL.md` at the skill root,
an `*.eval.ts` somewhere under it.

```
skills/
  my-skill/
    SKILL.md            ← anchor
    src/…
    test/
      my-skill.eval.ts  ← eval
```

Pathgrade walks up from the eval file looking for the nearest `SKILL.md`;
that directory is the **skill root**. Default dependency set is
`<skillRoot>/**` — so any change under `skills/my-skill/` reruns the eval.
No `__pathgradeMeta` needed.

### Declaring cross-skill and cross-cutting dependencies

Export a `__pathgradeMeta` constant from the eval to extend or override
the defaults. Pathgrade parses it via a TypeScript AST — the module is
**not executed** at selection time, so the value must be a literal
expression. Dynamic composition (`deps: [...BASE, 'extra']`) is not
supported; codegen the file if you need dedup.

```ts
import type { PathgradeMeta } from '@wix/pathgrade';

// Union extraDeps with the auto-detected skill root.
export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['shared/prompts/**'],
};

// Or: full override (skill-root anchor ignored).
export const __pathgradeMeta: PathgradeMeta = {
    deps: ['integration/**', 'shared/utils/**'],
};

// Or: always run, regardless of what changed (smoke tests).
export const __pathgradeMeta: PathgradeMeta = {
    alwaysRun: true,
};
```

### Repo-wide "rerun everything" triggers (`affected.global`)

Some changes affect every eval — lockfile bumps, pathgrade version
changes, shared runtime utilities. Declare these **once** in your vitest
config:

```ts
// vitest.config.ts
pathgrade({
    affected: {
        global: [
            'vitest.config.ts',
            'package.json',
            'package-lock.json',
            'skills/shared-runtime/**',
        ],
    },
})
```

Any changed file matching any glob here short-circuits the whole
pipeline: every eval runs. **Keep this list small** — each extra entry
reruns the full suite, which defeats the feature.

### onMissing: fail-closed by default

An eval with neither a `SKILL.md` ancestor nor a `__pathgradeMeta`
export is treated as "unknown deps" and reruns unconditionally, with a
yellow warning in the run-start summary and the PR comment. This is
deliberate: silently skipping an eval that *should* have run is worse
than paying the token cost.

For teams that want CI to fail rather than silently rerun:

```bash
npx pathgrade validate --affected
```

This exits non-zero on any onMissing or malformed eval. Run it as a
separate CI step after you've finished adopting `__pathgradeMeta`.

### Commands

- `pathgrade affected` — the primitive. Prints selected eval paths to
  stdout, one per line. Composable with matrix strategies, custom vitest
  invocations, etc. Flags: `--since=<ref>`, `--changed-files=<path>`,
  `--explain` (human-readable per-eval decision to stderr), `--json`
  (structured output to stdout).
- `pathgrade run --changed` — the ergonomic wrapper. Computes the
  affected set and spawns `vitest run <files>` with it. Empty selection
  short-circuits with `no affected evals` and exits 0 without invoking
  vitest. `--quiet` suppresses the run-start summary; args after `--`
  forward to vitest.
- `npx vitest run` — unchanged. Selection is a CLI-layer feature; the
  vitest plugin doesn't see it. Your raw escape hatch for local debugging.

**Note the `fetch-depth: 0`** requirement on the `actions/checkout` step for the
`--changed` variant — default shallow clones break merge-base resolution.

### Downstream: `results.json` and the PR comment

When `pathgrade run --changed` produced the run, `.pathgrade/results.json`
gains a `selection` field listing the selected and skipped file paths.
`pathgrade report` renders the same data as a `### Selection` section in
the PR comment. Reviewers can verify the right evals ran before approving
— closing the trust gap that was the biggest objection to auto-selection.

### Recommended pattern for demo / example evals

If your repo has example evals that shouldn't run on every PR (demos,
slow end-to-end fixtures, etc.):

1. Don't anchor them under a `SKILL.md` — they'll be onMissing and would
   rerun every PR, burning token budget.
2. Run your PR-CI with `pathgrade run --changed` — demo evals are
   skipped because nothing changed under their path.
3. Schedule a separate nightly workflow that runs the full suite
   (`pathgrade run`, no `--changed`) so examples still get coverage
   periodically.

Pathgrade's own repo follows this pattern for `examples/`.

## Best Practices

- **Grade outcomes, not implementation trivia.** Check that the right files exist with the right content, not that the agent used a specific sequence of commands.
- **Name expected output files in the instruction** if a scorer checks for them. Agents can't guess your file naming conventions.
- **Start small.** Begin with one or two clear tasks and a handful of trials before scaling out.
- **Combine scorer types.** Use `check()` for hard gates (file exists, tests pass) and `judge()` for soft evaluation (workflow quality, code style). Use `score()` for metrics with partial credit.
- **Use fail-fast.** Keep basic checks early so expensive LLM judge calls are skipped when preconditions fail.
- **Weight scorers intentionally.** Hard correctness checks should have higher weight than style/workflow checks.
- **Keep instructions clear.** Ambiguous instructions lead to noisy pass rates that are hard to interpret.
- **Use `PATHGRADE_AGENT` for cross-agent testing.** Write evals once and run them against both Claude and Codex via the env var.
- **Test your scorers.** Use `setRuntime()` to inject fake LLM responses and verify judge scorers parse scores correctly.

## Troubleshooting

**"Agent CLI not found"**: Ensure the agent CLI is installed and on your PATH:
- Claude: Install Claude Code per Anthropic's documentation
- Codex: Install the Codex CLI per OpenAI's documentation

**"Cannot use startChat() after prompt()"**: An agent supports only one interaction method. Create a separate agent for each interaction style.

**Low scores**: Check scorer results in `EvalResult.scorers` for per-scorer breakdowns. Look at `details` for error messages. If judge scorers consistently score low, review the rubric for ambiguity.

**Timeouts**: Increase `timeout` in `AgentOptions` or the plugin config. For conversation evals, `createAgent({ timeout: 'auto' })` gives you a conservative first-pass timeout estimate. Complex conversation tasks may still need manual tuning. The vitest test timeout is automatically set to `timeout + 30`.

**Empty agent output**: Check that the correct API key is set. On macOS, Claude can use Keychain credentials automatically. Otherwise, ensure `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set in the environment.

**"noReply" completion**: Your reactions don't cover the agent's response patterns and no persona is configured. Add a catch-all reaction (`when: /.*/`) or add a persona.

**Judge scorer returns `status: 'error'`**: The LLM call failed. Check the `details` field for the error message. Common causes: missing API key, rate limiting, network errors. Use `setRuntime()` to verify scorer logic independently, or set `onScorerError: 'fail'` to make these failures hard-stop CI.

**"skipped (fail-fast)" in scorer results**: A `check()` scorer scored 0, causing subsequent judge and toolUsage scorers to be skipped. Fix the failing check or disable fail-fast with `{ failFast: false }`.
