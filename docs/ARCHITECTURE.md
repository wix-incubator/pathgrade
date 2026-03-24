# Pathgrade Architecture Guide

Pathgrade is a local-first evaluation runner for agent skills. It executes agent trials in isolated local workspaces, supports both single-turn and conversation tasks, grades results with deterministic and rubric-based graders, and is moving toward a hybrid model where some LLM-backed features can use a host-scoped remote backend for secure employee-machine usage.

## Current Product Boundary

Today, Pathgrade keeps the main execution runtime local:

- local trial workspaces
- local agent CLI execution
- local conversation orchestration
- local deterministic graders

The approved next architecture slice keeps that local runtime intact and changes only the LLM-backed boundary used by:

- persona reply generation
- `llm_rubric` grading

That remote slice is documented in:

- [docs/2026-03-23-mcp-s-remote-llm-prd.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-prd.md)
- [docs/2026-03-23-mcp-s-remote-llm-spec.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-spec.md)

## Core Flow

1. `pathgrade` loads `eval.yaml` and detects any local `SKILL.md` directories.
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
│   └── skills.ts
├── agents/
│   ├── claude.ts
│   ├── codex.ts
│   ├── gemini.ts
│   └── registry.ts
├── providers/
│   └── local.ts
├── graders/
│   └── index.ts
├── reporters/
│   ├── browser.ts
│   └── cli.ts
├── conversationRunner.ts
├── evalRunner.ts
├── persona.ts
├── types.ts
└── utils/
    ├── cli.ts
    ├── env.ts
    └── llm.ts
```

Planned next addition:

- `src/utils/mcpS.ts` for deterministic host-scoped `mcp-s-cli` integration

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

- future secure LLM backend selection
- host-authenticated MCP-S access
- employee-machine secure mode configuration

Examples:

- `PATHGRADE_LLM_BACKEND`
- `PATHGRADE_MCP_S_*`
- host `HOME` / host `XDG_*` used by `mcp-s-cli`

Important boundary:

- trial-scoped runtime env is for agents
- host-scoped env is for future MCP-S calls
- host-authenticated MCP-S invocations must not inherit trial `HOME` / `XDG_*`

## `eval.yaml` Model

The active task format is still `eval.yaml`.

```yaml
version: "1"

defaults:
  agent: gemini
  trials: 5
  timeout: 300
  threshold: 0.8
  environment:
    cpus: 2
    memory_mb: 2048

tasks:
  - name: fix-linting-errors
    instruction: |
      Use the provided tool to fix the issue in app.js.
    workspace:
      - src: fixtures/app.js
        dest: app.js
    graders:
      - type: deterministic
        run: bash graders/check.sh
        weight: 0.7
      - type: llm_rubric
        rubric: |
          Did the agent solve the task cleanly and correctly?
        weight: 0.3
```

Conversation tasks add:

- `conversation.opener`
- `conversation.completion`
- scripted `conversation.replies`
- optional `conversation.persona`

Pathgrade no longer accepts `provider` or `docker` fields in `eval.yaml`. The agent runtime is always local.

Runtime backend settings for the future remote LLM path are intentionally not part of `eval.yaml`; they are host-process configuration.

## Main Components

### CLI

`src/pathgrade.ts` parses flags, dispatches commands, and keeps the public CLI surface aligned with the local-first runtime.

### Config Resolution

`src/core/config.ts` validates `eval.yaml`, rejects deprecated runtime fields, applies defaults, and resolves file references for instructions, conversations, and graders.

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

The adapters in `src/agents/*.ts` translate Pathgrade instructions into the native CLI contract for Gemini, Claude, and Codex.

Current continuation behavior:

- Claude uses native continuation support
- Gemini uses transcript continuation fallback
- Codex uses transcript continuation fallback

### LLM Boundary

`src/utils/llm.ts` is the shared LLM call boundary used by:

- `src/persona.ts`
- `src/graders/index.ts`

Current state:

- direct provider calls are made from the local process
- provider selection is inferred from model name and available API keys

Approved next state:

- keep a single shared LLM boundary
- add backend-aware routing for `local`, `mcp_s`, and `auto`
- keep the main agent loop local
- move only persona replies and `llm_rubric` to a host-scoped remote backend when secure mode is enabled

### Graders

`src/graders/index.ts` supports:

- deterministic graders that execute shell commands and parse JSON from stdout
- rubric graders that judge qualitative behavior from the transcript

Step graders are planned next after the Remote LLM Backend slice.

## Output

Reports are written under `$TMPDIR/pathgrade/<skill-name>/results/` by default. Each task report includes:

- aggregate pass metrics
- per-trial reward and duration
- grader results
- redacted session logs
- conversation metadata when present

## Current Direction

The current runtime foundation for conversations is in place. The next architectural slice is the secure remote LLM backend for persona replies and `llm_rubric`, while keeping:

- local agent execution
- local workspace isolation
- local deterministic grading

After that, the next major architectural work remains:

- step graders
- richer transcript/reporting support
- conversation-aware browser/CLI reporting
