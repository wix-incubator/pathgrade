# Pathgrade Architecture Guide

Pathgrade is a local-only runtime for evaluating whether AI agents discover and use your skills correctly. It runs trials in isolated local workspaces by default, grades the results with deterministic and rubric-based graders, and aggregates those scores into repeatable reports.

## Core Flow

1. `pathgrade` loads `eval.yaml` and detects any local `SKILL.md` directories.
2. `run.ts` resolves each task into concrete instruction text, grader content, and workspace mappings.
3. `EvalRunner` creates one isolated local trial runtime per attempt.
4. The chosen agent adapter runs inside that runtime and calls back into the provider for shell execution.
5. Graders evaluate the resulting files and session log.
6. Reporters persist JSON output and optionally render CLI or browser views.

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
├── evalRunner.ts
├── types.ts
└── utils/
    ├── cli.ts
    └── env.ts
```

## Runtime Model

Every trial gets its own isolated filesystem root under the output directory. The local provider creates:

- `workspace/` for task files and agent edits
- `home/` for agent home-directory state
- `xdg/` for config/cache/data isolation
- `tmp/` for temp files such as prompt payloads

The provider also exports runtime env vars so agent CLIs keep their state inside the trial instead of leaking into the host user profile.

## `eval.yaml` Model

The active config surface is intentionally small:

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

Pathgrade no longer accepts `provider` or `docker` fields in `eval.yaml`. The runtime is always local.

## Main Components

### CLI

`src/pathgrade.ts` parses flags, dispatches commands, and keeps the public CLI surface aligned with the local-only runtime.

### Config Resolution

`src/core/config.ts` validates `eval.yaml`, rejects deprecated runtime fields, applies defaults, and resolves file references for instructions and graders.

### Trial Execution

`src/evalRunner.ts` owns the trial lifecycle:

- provider setup
- agent execution
- timeout handling
- grader execution
- log persistence
- cleanup

The current single-turn path already runs through the newer session-capable agent boundary so future multi-turn work can build on the same runtime.

### Local Provider

`src/providers/local.ts` is the only runtime provider. It creates the isolated trial directories, copies workspace fixtures, runs commands with abort support, and removes the runtime after each trial.

### Agent Adapters

The adapters in `src/agents/*.ts` translate Pathgrade instructions into the native CLI contract for Gemini, Claude, and Codex. They already support a session-oriented shape:

- Claude uses native continuation support
- Gemini uses transcript continuation fallback
- Codex uses transcript continuation fallback

### Graders

`src/graders/index.ts` supports:

- deterministic graders that execute shell commands and parse JSON from stdout
- rubric graders that judge qualitative behavior from the transcript

## Output

Reports are written under `$TMPDIR/pathgrade/<skill-name>/results/` by default. Each task report includes:

- aggregate pass metrics
- per-trial reward and duration
- grader results
- redacted session logs

## Current Direction

This document reflects the post-Docker local-only architecture. The next major step is the conversation runner that will use the same per-trial isolation and session-capable agent boundary for multi-turn evaluations.
