# Pathgrade User Guide

Pathgrade evaluates whether AI agents correctly discover and use your skills. It runs agents in isolated local workspaces, grades their output with deterministic, LLM-rubric, and tool-usage graders, and reports pass rates with statistical confidence metrics.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Writing an Eval Config](#writing-an-eval-config)
  - [defineEval](#defineeval)
  - [Defaults](#defaults)
  - [Tasks](#tasks)
  - [Instruction Tasks](#instruction-tasks)
  - [Conversation Tasks](#conversation-tasks)
  - [Workspace Mappings](#workspace-mappings)
- [Graders](#graders)
  - [Deterministic Graders](#deterministic-graders)
  - [LLM Rubric Graders](#llm-rubric-graders)
  - [Tool Usage Graders](#tool-usage-graders)
  - [Step Graders](#step-graders)
- [Conversations In Depth](#conversations-in-depth)
  - [Completion Conditions](#completion-conditions)
  - [Reactions](#reactions)
  - [Personas](#personas)
- [MCP Support](#mcp-support)
  - [Real MCP Configs](#real-mcp-configs)
  - [Mock MCP Servers](#mock-mcp-servers)
- [Agents](#agents)
- [CLI Reference](#cli-reference)
  - [Commands](#commands)
  - [Presets](#presets)
  - [Options](#options)
- [Environment Variables](#environment-variables)
- [Reviewing Results](#reviewing-results)
  - [CLI Preview](#cli-preview)
  - [Browser Preview](#browser-preview)
  - [Report JSON Structure](#report-json-structure)
- [CI Integration](#ci-integration)
- [Validating Graders](#validating-graders)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Installation

**Prerequisites**: Node.js 20+

```bash
npm i -g @wix/pathgrade
```

Verify installation:

```bash
pathgrade --help
```

## Quick Start

1. Navigate to a directory containing a `SKILL.md` file:

```bash
cd my-skill/
```

2. Generate an eval config:

```bash
GEMINI_API_KEY=your-key pathgrade init
```

This auto-detects your skill and generates a `my-skill.eval.ts` file with sensible defaults.

3. Run the eval:

```bash
GEMINI_API_KEY=your-key pathgrade --smoke
```

4. Review results:

```bash
pathgrade preview
pathgrade preview browser
```

Reports are saved to `$TMPDIR/pathgrade/<skill-name>/results/` by default.

## How It Works

Pathgrade runs each evaluation through a pipeline:

1. **Load config**: Your `*.eval.ts` file is loaded and validated.
2. **Detect skills**: `SKILL.md` files are found and staged into trial workspaces.
3. **Create isolation**: Each trial gets its own workspace, home directory, XDG dirs, and temp directory.
4. **Run agent**: The chosen agent CLI (claude, gemini, or codex) receives the instruction or conversation opener and executes in the isolated workspace.
5. **Grade results**: Graders evaluate the workspace state and session transcript.
6. **Aggregate metrics**: Pass rates, pass@k, and pass^k are computed across all trials.
7. **Report**: Results are saved as JSON and displayed via CLI or browser.

Each trial gets its own directory tree so agents don't share state between runs. Note that isolation is convention-based (separate HOME, XDG, TMPDIR, and cwd) rather than a hard sandbox — agents are not prevented from accessing the host filesystem. When Claude or Codex CLIs are available locally, pathgrade auto-enables host-auth mode, which preserves the real HOME for CLI credentials while still isolating the workspace via cwd. API keys are redacted from persisted logs.

## Writing an Eval Config

Eval configs are TypeScript files that export a `defineEval()` call. The file must be named `*.eval.ts`.

### defineEval

```typescript
import { defineEval } from '@wix/pathgrade';

export default defineEval({
  // Optional: explicit path to the skill directory
  skillPath: 'path/to/my-skill',

  defaults: { /* ... */ },
  tasks: [ /* ... */ ],
});
```

The `skillPath` field is optional. When omitted, pathgrade auto-detects `SKILL.md` files in the eval directory.

### Defaults

Top-level defaults apply to all tasks unless overridden at the task level:

```typescript
defaults: {
  agent: 'gemini',              // 'gemini' | 'claude' | 'codex'
  trials: 5,                    // Number of trials per task
  timeout: 300,                 // Seconds per trial
  threshold: 0.8,               // Pass threshold for --ci mode
  grader_model: 'gemini-2.0-flash',  // LLM model for rubric graders
  environment: {
    cpus: 2,                    // Resource hint (reserved for future use)
    memory_mb: 2048,            // Resource hint (reserved for future use)
  },
  mcp_config: './mcp-config.json',   // MCP server config (Claude only)
  mcp_mock: mockMcpServer({...}),    // Mock MCP server (all agents)
}
```

If you omit `defaults` entirely, pathgrade uses:
- agent: `gemini`
- trials: `5`
- timeout: `300`
- threshold: `0.8`
- environment: `{ cpus: 2, memory_mb: 2048 }`

### Tasks

Each task defines a single evaluation scenario. Every task must have a `name`, `type`, and at least one grader.

### Instruction Tasks

One-shot tasks where the agent receives a single instruction and executes:

```typescript
{
  name: 'fix-the-bug',
  type: 'instruction',
  instruction: `Read app.js, find the bug, and fix it so add(2,3) returns 5.`,
  workspace: [
    { dir: 'fixtures' },
  ],
  graders: [
    deterministicGrader({ execute: myCheck }),
    llmRubricGrader({ rubric: 'Did the agent solve the task cleanly?' }),
  ],
}
```

The `instruction` field supports file references — if the value is a path to an existing file, pathgrade reads the file content:

```typescript
instruction: 'instructions/fix-bug.md',  // reads the file
```

### Conversation Tasks

Multi-turn tasks where the agent engages in dialogue:

```typescript
{
  name: 'guided-project-setup',
  type: 'conversation',
  conversation: {
    opener: 'I want to start a new project. I have an idea for a feature.',
    completion: {
      max_turns: 12,
      signal: 'artifacts/project-brief-*.md',
    },
    reactions: [
      { when: 'goal|trying to achieve', reply: 'Solve a user pain point' },
      { when: 'target|audience', reply: 'Self-Creator' },
    ],
    persona: {
      description: 'You are a product manager who communicates concisely.',
      facts: [
        'The feature is for online stores',
        'Target users are store owners',
      ],
    },
  },
  graders: [ /* ... */ ],
}
```

See [Conversations In Depth](#conversations-in-depth) for full details.

### Workspace Mappings

The `workspace` field copies files from your eval directory into the trial workspace:

```typescript
workspace: [
  // Copy a single file
  { src: 'fixtures/broken-app.js', dest: 'app.js' },

  // Copy a file and make it executable
  { src: 'bin/superlint', dest: '/usr/local/bin/superlint', chmod: '+x' },

  // Mirror an entire directory
  { dir: 'fixtures' },

  // Mirror a directory and make all files executable
  { dir: 'bin', chmod: '+x' },
]
```

## Graders

Every task must have at least one grader. Graders are weighted and their scores are combined into a single reward (0.0 to 1.0) per trial. A trial passes when its reward is >= 0.5.

### Deterministic Graders

Run custom logic against the trial workspace. Use the factory function for TypeScript graders:

```typescript
import { deterministicGrader } from '@wix/pathgrade';

const checkOutput = deterministicGrader({
  weight: 0.7,
  execute: async (ctx) => {
    const result = await ctx.runCommand('node validate.js');
    const fileExists = require('fs').existsSync(
      require('path').join(ctx.workspacePath, 'output.txt')
    );

    return {
      score: fileExists ? 1.0 : 0.0,
      details: fileExists ? 'Output file created' : 'Output file missing',
      checks: [
        { name: 'file-created', passed: fileExists, message: 'output.txt exists' },
      ],
    };
  },
});
```

**GraderContext** provides:

| Field | Type | Description |
|-------|------|-------------|
| `workspacePath` | `string` | Absolute path to the trial workspace |
| `runCommand(cmd)` | `(string) => Promise<CommandResult>` | Execute a shell command in the workspace |
| `sessionLog` | `LogEntry[]` | Full session log (commands, agent output, tool events) |
| `env` | `Record<string, string>` | Environment variables |
| `signal` | `AbortSignal?` | Abort signal for timeout handling |

**GraderOutput** shape:

```typescript
{
  score: number;          // 0.0 to 1.0 (clamped by pathgrade)
  details?: string;       // Human-readable summary
  checks?: Array<{       // Per-check breakdown
    name: string;
    passed: boolean;
    message?: string;
  }>;
}
```

### LLM Rubric Graders

Send the full session transcript to an LLM for qualitative evaluation:

```typescript
import { llmRubricGrader } from '@wix/pathgrade';

const rubricWorkflow = llmRubricGrader({
  weight: 0.3,
  rubric: `Workflow Compliance (0-0.5):
- Did the agent follow the expected steps?
- Did it run the check command before the fix command?

Efficiency (0-0.5):
- Did it avoid unnecessary commands?
- Was the solution clean?`,
  model: 'gemini-2.0-flash',           // Optional model override
  include_tool_events: true,            // Include normalized tool events in transcript
});
```

The `rubric` field supports file references:

```typescript
rubric: 'rubrics/workflow-quality.md',  // reads the file
```

### Tool Usage Graders

Validate normalized agent tool events against declarative expectations:

```typescript
import { toolUsageGrader } from '@wix/pathgrade';

const checkToolUsage = toolUsageGrader({
  weight: 0.4,
  expectations: [
    { action: 'read_file', min: 1, weight: 0.3 },
    { action: 'edit_file', min: 1, weight: 0.3 },
    { action: 'run_shell', command_contains: 'test', min: 1, weight: 0.4 },
  ],
});
```

**Normalized actions**: `run_shell`, `read_file`, `write_file`, `edit_file`, `search_code`, `list_files`, `ask_user`, `web_fetch`, `unknown`.

**Expectation filters**:

| Filter | Description |
|--------|-------------|
| `action` | Normalized action name (required) |
| `min` | Minimum occurrences |
| `max` | Maximum occurrences |
| `provider` | Filter by agent (`claude`, `gemini`, `codex`) |
| `path` | Filter by file path |
| `command_contains` | Filter shell commands containing a substring |
| `argument_pattern` | Regex tested against all string values in arguments |
| `tool_name` | Match the provider-specific tool name |
| `weight` | Weight of this expectation within the grader |

### Step Graders

Grade at intermediate points during a conversation:

```typescript
conversation: {
  // ...
  step_graders: [
    {
      after_turn: 3,
      graders: [
        deterministicGrader({
          execute: async (ctx) => {
            // Check state after turn 3
            const exists = require('fs').existsSync(
              require('path').join(ctx.workspacePath, 'draft.md')
            );
            return { score: exists ? 1.0 : 0.0 };
          },
        }),
      ],
    },
  ],
}
```

Step graders run after the specified turn completes, before the next reply is chosen.

## Conversations In Depth

### Completion Conditions

A conversation ends when any completion condition is met:

```typescript
completion: {
  max_turns: 12,           // Hard limit on turns (required)
  signal: 'artifacts/project-brief-*.md',  // Glob: ends when file appears in workspace
  done_phrase: 'COMPLETE|FINISHED',        // Regex: ends when agent says this
  done_when: 'The agent has written and saved the project brief',  // LLM judges semantically
  timeout: 300,            // Conversation-level timeout in seconds
}
```

Conditions are checked in order: `signal` > `done_phrase` > `max_turns` > `done_when`. The `done_when` condition uses an LLM call and only runs if cheaper checks don't trigger first.

Completion reasons in reports: `signal`, `done_phrase`, `max_turns`, `done_when`, `timeout`, `no_replies`, `error`.

### Reactions

Scripted regex-based replies. The first matching reaction is used:

```typescript
reactions: [
  { when: 'goal|trying to achieve', reply: 'Solve a user pain point' },
  { when: 'target|audience', reply: 'Self-Creator' },
  { when: 'confirm|sound right', reply: 'Yes, that is correct.' },

  // Catch-all (consumed after first match)
  {
    when: '.*',
    reply: 'It is for the online stores platform.',
    once: true,
  },
]
```

- `when`: Regex pattern (case-insensitive) tested against the agent's latest message.
- `reply`: The response to send. Supports file references.
- `once`: If true, this reaction is consumed after first use and won't match again.

Reactions are evaluated in order. The first match wins. If no reaction matches and no persona is configured, the conversation ends with `no_replies`.

### Personas

LLM-simulated conversation partners that respond naturally based on a character description and facts:

```typescript
persona: {
  description: `You are a product manager at Wix who has worked on the Stores
platform for 2 years. You communicate directly and concisely.`,
  facts: [
    'The feature is for the Wix Stores platform',
    'Target users are Self-Creators',
    'Goal: solve user pain point',
    'No GitHub repos to link right now',
  ],
  model: 'gemini-2.0-flash',  // Optional model override
}
```

When both reactions and a persona are configured, reactions are tried first. If no reaction matches, the persona generates a reply. This lets you combine scripted responses for predictable questions with natural LLM-generated responses for unexpected ones.

## MCP Support

### Real MCP Configs

Pass a real MCP server configuration to the agent (Claude only):

```typescript
{
  name: 'my-task',
  type: 'instruction',
  mcp_config: './mcp-config.json',
  // ...
}
```

The config file is staged into the trial workspace and passed to the Claude CLI via `--mcp-config`.

### Mock MCP Servers

Create fake MCP servers with predefined responses (works with all agents):

```typescript
import { mockMcpServer } from '@wix/pathgrade/mcp-mock';

const kbMock = mockMcpServer({
  name: 'kb-retrieval',
  tools: [
    {
      name: 'retrieve_documents',
      description: 'Retrieve documents from the knowledge base',
      when: 'knowledge_base_id.*abc123',  // Regex filter on arguments
      response: {
        documents: [
          { title: 'API Guide', content: '...' },
        ],
      },
    },
  ],
});

// Use in a task:
{
  name: 'my-task',
  mcp_mock: kbMock,
  // ...
}
```

Mock MCP servers are useful for testing skills that depend on external services without requiring real infrastructure.

## Agents

Pathgrade supports three agent runtimes:

| Agent | CLI Tool | Session Model | MCP Support | Auth |
|-------|----------|---------------|-------------|------|
| **Gemini** | `gemini` | Transcript re-injection | Mock only | API key |
| **Claude** | `claude` | Native session resume | Real + Mock | API key or host OAuth |
| **Codex** | `codex` | Transcript re-injection | Mock only | API key or host auth |

**Agent selection priority**: `--agent` CLI flag > task-level `agent` field > `defaults.agent` in eval config. The built-in default is `gemini` when no config is provided.

During `pathgrade init`, the LLM backend is auto-detected from whichever API key is set (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`). This does **not** apply to eval runs — those always use the configured agent.

**Auth modes**:
- **Host** (auto-enabled for Claude and Codex when their CLIs are installed): Trial preserves the real HOME directory so the agent can use existing CLI credentials. The workspace is still isolated via `cwd`.
- **Isolated** (Gemini, or Claude/Codex when their CLIs are not installed): Trial gets a fresh HOME directory. The agent must authenticate via environment API keys.

## CLI Reference

### Commands

```bash
pathgrade                    # Run all evals in the current directory
pathgrade init               # Generate an eval.ts from detected skills
pathgrade init --force       # Overwrite existing eval.ts
pathgrade preview            # Show results as a CLI table
pathgrade preview browser    # Open results in a browser
```

### Presets

| Flag | Trials | Use Case |
|------|--------|----------|
| `--smoke` | 5 | Quick capability check |
| `--reliable` | 15 | Reliable pass rate estimate |
| `--regression` | 30 | High-confidence regression detection |

### Options

| Flag | Description |
|------|-------------|
| `--eval=NAME[,NAME]` | Run specific evals by name |
| `--grader=TYPE` | Run only `deterministic`, `llm_rubric`, or `tool_usage` graders |
| `--trials=N` | Override trial count |
| `--parallel=N` | Run trials concurrently |
| `--agent=gemini\|claude\|codex` | Override agent selection |
| `--output=DIR` | Output directory for reports |
| `--validate` | Verify graders with a reference solution |
| `--ci` | Exit non-zero if pass rate below threshold |
| `--threshold=0.8` | Pass rate threshold for `--ci` |
| `--preview` | Show CLI preview after run |

## Environment Variables

| Variable | Used By |
|----------|---------|
| `GEMINI_API_KEY` | Gemini agent, LLM rubric grading, persona replies, `pathgrade init` |
| `ANTHROPIC_API_KEY` | Claude agent, LLM rubric grading, persona replies, `pathgrade init` |
| `OPENAI_API_KEY` | Codex agent, `pathgrade init` |

Pathgrade also loads `.env` from the eval directory. Persisted logs redact API key values automatically.

## Reviewing Results

### CLI Preview

```bash
pathgrade preview
```

Displays:
- Pass rate, pass@k, pass^k per task
- Per-trial breakdown: status, reward, duration, command count
- Grader scores and details per trial
- LLM rubric reasoning excerpts

### Browser Preview

```bash
pathgrade preview browser
```

Starts a local HTTP server and prints the URL. Open the URL in your browser to view an interactive report.

### Report JSON Structure

Reports are saved to `$TMPDIR/pathgrade/<skill-name>/results/` as JSON files:

```json
{
  "task": "fix-linting-errors",
  "pass_rate": 0.8,
  "pass_at_k": 0.99,
  "pass_pow_k": 0.33,
  "skills_used": ["superlint"],
  "trials": [
    {
      "trial_id": 1,
      "reward": 0.85,
      "grader_results": [
        { "grader_type": "deterministic", "score": 1.0, "weight": 0.7, "details": "2/2 checks passed" },
        { "grader_type": "llm_rubric", "score": 0.5, "weight": 0.3, "details": "..." }
      ],
      "duration_ms": 45200,
      "n_commands": 8,
      "input_tokens": 512,
      "output_tokens": 2048,
      "session_log": [ /* ... */ ]
    }
  ]
}
```

**Metrics**:
- `pass_rate`: Mean reward across trials.
- `pass_at_k`: Probability of at least one success in k trials.
- `pass_pow_k`: Probability of all k trials succeeding.

**Conversation reports** include additional turn-level data:

```json
{
  "conversation": {
    "turns": [
      {
        "turn_number": 1,
        "user_message": "I want to start a new project.",
        "user_message_source": "opener",
        "assistant_message": "What kind of project?",
        "duration_ms": 8000,
        "turn_status": "completed"
      }
    ],
    "total_turns": 8,
    "completion_reason": "signal"
  }
}
```

## CI Integration

```yaml
# GitHub Actions example
- name: Run pathgrade
  run: |
    npm i -g @wix/pathgrade
    cd skills/superlint
    GEMINI_API_KEY=${{ secrets.GEMINI_API_KEY }} pathgrade --regression --ci
```

The `--ci` flag causes pathgrade to exit with a non-zero code if the pass rate falls below the threshold (default 0.8, override with `--threshold`).

For faster CI runs, use `--smoke` (5 trials). For release gates, use `--regression` (30 trials).

## Validating Graders

Before trusting eval results, verify your graders work correctly:

```bash
pathgrade --validate
```

This requires a `solution` field on your task pointing to a script that produces the correct output:

```typescript
{
  name: 'fix-the-bug',
  type: 'instruction',
  instruction: '...',
  solution: 'solve-fix.sh',    // Script that creates correct workspace state
  graders: [ /* ... */ ],
}
```

Pathgrade runs the solution script, then runs your graders against the resulting workspace. If graders don't pass on correct output, something is wrong with the graders.

## Best Practices

- **Grade outcomes, not implementation trivia.** Check that the right files exist with the right content, not that the agent used a specific sequence of commands.
- **Name expected output files in the instruction** if a grader checks for them. Agents can't guess your file naming conventions.
- **Validate graders first** with `--validate` before trusting eval results.
- **Start small.** Begin with one or two clear tasks and a handful of trials before scaling out.
- **Combine grader types.** Use deterministic graders for hard checks (file exists, content correct) and LLM rubrics for soft checks (workflow quality, conversation naturalness).
- **Use `--smoke` during development** and `--regression` for CI gates.
- **Weight graders intentionally.** Hard correctness checks should have higher weight than style/workflow checks.
- **Keep instructions clear.** Ambiguous instructions lead to noisy pass rates that are hard to interpret.

## Troubleshooting

**"Agent CLI not found"**: Ensure the agent CLI is installed and on your PATH:
- Gemini: Install the Gemini CLI per Google's documentation
- Claude: Install Claude Code per Anthropic's documentation
- Codex: Install the Codex CLI per OpenAI's documentation

**Low pass rates**: Run `--validate` to check your graders first. If graders pass on the solution but fail on agent output, the agent is genuinely failing. If graders also fail on the solution, fix the graders.

**Timeouts**: Increase `timeout` in your eval config. Complex conversation tasks may need 600+ seconds.

**Empty agent output**: Check that the correct API key is set. In isolated mode, agents can only authenticate via environment variables.

**"No replies" completion**: Your reactions don't cover the agent's response patterns and no persona is configured. Add a catch-all reaction (`when: '.*'`) or add a persona.

**Grader errors in reports**: Check the `details` field in grader results for the error message. Common causes: grader script not found, shell command failed, LLM API error.
