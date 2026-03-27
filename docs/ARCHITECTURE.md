# Pathgrade Architecture Guide

Pathgrade is a local-first evaluation runner for agent skills. It runs trials in isolated local workspaces by default, supports both single-turn and conversation tasks, and grades results with deterministic and rubric-based graders. LLM-backed features (persona replies, `llm_rubric` grading, init generation) use a CLI-first model: Claude CLI via the host's OAuth session when available, with API-key fallback for CI.

## Product Boundary

Pathgrade keeps the entire execution runtime local:

- local trial workspaces
- local agent CLI execution
- local conversation orchestration
- local deterministic graders
- local LLM-backed grading and persona replies (via Claude CLI or API keys)

## Core Flow

1. `pathgrade` loads `eval.ts` and detects any local `SKILL.md` directories.
2. `run.ts` resolves each task into concrete instruction text, conversation config, grader content, and workspace mappings.
3. `EvalRunner` creates one isolated local trial runtime per attempt.
4. The chosen agent adapter runs inside that runtime and calls back into the local provider for shell execution.
5. For conversation tasks, `conversationRunner` dispatches scripted replies or persona-backed replies and tracks turn state.
6. Graders evaluate the resulting files and session log.
7. Reporters persist JSON output and optionally render CLI or browser views.

## Project Layout

```text
src/
├── pathgrade.ts
├── commands/
│   ├── init.ts
│   ├── preview.ts
│   └── run.ts
├── core/
│   ├── config.ts
│   ├── config.types.ts
│   ├── defaults.ts
│   ├── define-eval.ts
│   ├── index.ts
│   └── skills.ts
├── agents/
│   ├── claude.ts
│   ├── codex.ts
│   ├── gemini.ts
│   ├── registry.ts
│   └── transcript-agent.ts
├── providers/
│   └── local.ts
├── graders/
│   ├── index.ts
│   ├── paths.ts
│   └── tool-usage.ts
├── reporters/
│   ├── browser.ts
│   └── cli.ts
├── analytics/
│   └── engine.ts
├── conversationRunner.ts
├── evalRunner.ts
├── persona.ts
├── tool-events.ts
├── tool-event-extractors.ts
├── types.ts
├── viewer.html
└── utils/
    ├── cli.ts
    ├── cli-llm.ts
    ├── env.ts
    ├── llm.ts
    ├── shutdown.ts
    └── timeout.ts
```

## Runtime Model

Every trial gets its own isolated filesystem root under the output directory. The local provider creates:

- `workspace/` for task files and agent edits
- `home/` for agent home-directory state
- `xdg/` for config/cache/data isolation
- `tmp/` for temp files such as prompt payloads

This isolation exists so agent CLIs can keep per-trial state without leaking into the host user profile.

### Trial-Scoped Versus Host-Scoped State

Pathgrade now has two architectural state domains:

### Trial-scoped state

Used for:

- agent execution
- command execution
- workspace artifacts
- agent session continuation

Examples:

- `HOME` inside the trial root
- `XDG_CONFIG_HOME` inside the trial root
- `TMPDIR` inside the trial root

### Host-scoped state

Used for:

- CLI-first LLM calls (Claude CLI uses host OAuth session)
- host-auth passthrough mode for solver agents

Examples:

- host `HOME` preserving CLI login state
- `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for API-key fallback in CI

Important boundary:

- trial-scoped runtime env is for agents
- host-scoped env is for LLM-backed features (grading, persona, init)
- host-auth passthrough preserves real `HOME` while isolating the workspace via `cwd`

## `eval.ts` Model

The eval config format is `eval.ts` using `defineEval()`.

```typescript
import { defineEval } from '@wix/pathgrade';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    environment: { cpus: 2, memory_mb: 2048 },
  },

  tasks: [
    {
      name: 'fix-linting-errors',
      instruction: `Use the provided tool to fix the issue in app.js.`,
      workspace: [
        { src: 'fixtures/app.js', dest: 'app.js' },
      ],
      graders: [
        {
          type: 'deterministic',
          run: 'bash graders/check.sh',
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: `Did the agent solve the task cleanly and correctly?`,
          weight: 0.3,
        },
      ],
    },
  ],
});
```

Conversation tasks add:

- `conversation.opener`
- `conversation.completion`
- scripted `conversation.replies`
- optional `conversation.persona`

Pathgrade no longer accepts `provider` or `docker` fields in `eval.ts`. The agent runtime is always local.

LLM backend selection (CLI vs API keys) is determined at runtime by `callLLM()` in `src/utils/llm.ts`, not by `eval.ts`.

## Main Components

### CLI

`src/pathgrade.ts` parses flags, dispatches commands, and keeps the public CLI surface aligned with the local-only runtime.

### Config Resolution

`src/core/config.ts` validates `eval.ts`, rejects deprecated runtime fields, applies defaults, and resolves file references for instructions, conversations, and graders.

### Trial Execution

`src/evalRunner.ts` owns the trial lifecycle:

- provider setup
- single-turn or conversation execution
- timeout handling
- grader execution
- log persistence
- cleanup

The current runtime already uses a session-capable agent boundary so single-turn and conversation tasks share the same underlying local trial model.

### Conversation Runtime

`src/conversationRunner.ts` owns the multi-turn loop:

- sending the opener
- continuing the agent session
- choosing the next reply
- checking completion
- recording turn-level logs

Reply sources are currently:

- scripted ordered replies
- scripted pattern-matched replies
- persona-backed LLM replies

### Local Provider

`src/providers/local.ts` is the only execution provider. It creates the isolated trial directories, copies workspace fixtures, runs commands with abort support, and removes the runtime after each trial.

### Agent Adapters

The adapters in `src/agents/*.ts` translate Pathgrade instructions into the native CLI contract for Gemini, Claude, and Codex. Gemini and Codex extend `TranscriptAgent` (`src/agents/transcript-agent.ts`), a shared base class that handles session management, transcript accumulation, and prompt file writing for agents that use transcript re-injection for multi-turn conversations.

Current continuation behavior:

- Claude uses native continuation support
- Gemini uses transcript continuation fallback (via `TranscriptAgent`)
- Codex uses transcript continuation fallback (via `TranscriptAgent`)

### LLM Boundary

`src/utils/llm.ts` is the shared LLM call boundary used by:

- `src/commands/init.ts`
- `src/persona.ts`
- `src/graders/index.ts`

Current behavior:

- CLI-first: when Claude CLI is installed with an active OAuth session, `callLLM()` routes through `callClaudeCli()` in `src/utils/cli-llm.ts` unless a non-Claude model is explicitly requested
- API-key fallback: when Claude CLI is unavailable, or when a non-Claude model is explicitly requested, uses direct provider HTTP calls (Gemini -> Anthropic -> OpenAI)
- model guard: non-Claude models requested without API keys throw a clear error instead of silently substituting Claude

### Graders

`src/graders/index.ts` supports:

- deterministic graders that execute shell commands and parse JSON from stdout
- rubric graders that judge qualitative behavior from the transcript
- tool_usage graders that match normalized tool events against expected action patterns

Grader path conventions (`.pathgrade/tests/`, `.pathgrade/prompts/`, step subdirectories) are centralized in `src/graders/paths.ts`.

### Tool Event Pipeline

`src/tool-events.ts` defines a normalized `ToolEvent` type (action, provider, tool name, arguments, confidence). `src/tool-event-extractors.ts` parses agent-specific trace output (Codex `tool:` lines, Gemini `tool:` lines, Claude `stream-json` events) into these normalized events. The `tool_usage` grader in `src/graders/tool-usage.ts` matches extracted events against expectations like "searched before editing" or "ran a specific command."

### Process Management

`src/utils/shutdown.ts` provides `ShutdownManager` for graceful cleanup on Ctrl+C — it registers per-trial cleanup functions and runs them on SIGINT/SIGTERM. `src/utils/timeout.ts` provides `withAbortTimeout` for unified timeout handling across agent and grader execution, propagating an `AbortSignal` to kill child processes.

### Analytics

`src/analytics/engine.ts` computes Normalized Gain (NG) metrics by comparing pass rates with and without skills, loading and aggregating report JSON from the output directory.

## Output

Reports are written under `$TMPDIR/pathgrade/<skill-name>/results/` by default. Each task report includes:

- aggregate pass metrics
- per-trial reward and duration
- grader results
- redacted session logs
- conversation metadata when present

## Current Direction

The runtime foundation for conversations, CLI-first local LLM, and tool-aware grading are in place. The next major work is:

- Codex CLI skill bootstrap (`--agent=codex` with generated `AGENTS.md` and staged skill directories)
- conversation-aware `--validate` support
- richer transcript/reporting support
- conversation-aware browser/CLI reporting
