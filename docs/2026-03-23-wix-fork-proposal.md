# Wix Fork Proposal for Multi-Turn Skillgrade

**Date:** 2026-03-23
**Status:** Proposed
**Author:** Codex

## Decision

Build a **new Wix-owned repository derived from the current `skillgrade` codebase**.

This is a hard fork in product terms, not a greenfield rewrite and not an in-place upstream-compatible refactor.

## Why This Direction

The three requested changes line up poorly with the current architecture:

1. **No Docker**
   The current runtime still treats Docker as a first-class provider and default execution model.

2. **TypeScript config instead of YAML**
   This is a straightforward improvement, but it is only a small part of the needed change.

3. **Multi-turn conversation evals**
   This is the real boundary change. The current system is built around one instruction, one agent invocation, then grading.

Forking keeps the working parts:
- local workspace setup
- grader pipeline
- reporters
- skill discovery
- CLI shell

Creating a new repo gives room to remove the wrong abstractions early:
- provider split centered on Docker vs local
- single-turn `agent.run()` contract
- YAML-first authoring model

## Recommended Repository Shape

### Name

Chosen:
- **Product:** `Pathgrade`
- **Repo:** `pathgrade`
- **Package:** `@wix/pathgrade`
- **CLI:** `pathgrade`

Why:
- describes the value of the tool, not just the implementation detail
- fits both conversational and non-conversational workflow evals
- keeps continuity with `skillgrade` through the `grade` suffix without inheriting the old product boundary

## Product Boundary

The new repo should define the product as:

> A local-first evaluation runner for agent skills, optimized for multi-turn conversations and typed configuration.

That means:
- local execution only in v1
- isolated per-trial homes and workspaces
- session-aware agent adapters
- conversation-native grading and logging

## Proposed Directory Layout

```text
pathgrade/
  src/
    cli/
      index.ts
      commands/
        run.ts
        init.ts
        preview.ts
        migrate.ts
    config/
      define-eval.ts
      loader.ts
      defaults.ts
      normalize.ts
      types.ts
    runtime/
      trial-root.ts
      workspace.ts
      conversation-runner.ts
      single-turn-runner.ts
      completion.ts
      transcript.ts
    agents/
      types.ts
      registry.ts
      claude.ts
      codex.ts
      gemini.ts
    replies/
      dispatcher.ts
      scripted.ts
      persona-llm.ts
    graders/
      registry.ts
      deterministic.ts
      llm-rubric.ts
      step-aggregator.ts
    reporters/
      cli.ts
      browser.ts
      json.ts
    skills/
      discovery.ts
      injection.ts
    utils/
      fs.ts
      env.ts
      process.ts
      tokens.ts
  tests/
    config/
    runtime/
    replies/
    graders/
    e2e/
  examples/
    ck-new/
      eval.ts
    ck-status/
      eval.ts
  docs/
    architecture.md
    migration.md
```

## Core Architecture Changes

### 1. Replace providers with a local runtime

Current model:
- `DockerProvider`
- `LocalProvider`

Proposed model:
- one `TrialRoot` abstraction that creates:
  - `workspace/`
  - `home/`
  - `xdg/`
  - `tmp/`

This is the key enabler for multi-turn continuation because agent CLIs need stable home/state directories across turns.

### 2. Replace `agent.run()` with a turn-based agent session

Current model:

```ts
agent.run(instruction, workspacePath, runCommand): Promise<string>
```

Proposed model:

```ts
export interface AgentTurnInput {
  message: string;
  continueSession?: boolean;
}

export interface AgentTurnResult {
  rawOutput: string;
  assistantMessage: string;
  exitCode: number;
}

export interface AgentSession {
  start(input: AgentTurnInput): Promise<AgentTurnResult>;
  reply(input: AgentTurnInput): Promise<AgentTurnResult>;
}

export interface AgentAdapter {
  createSession(runtime: TrialRuntime): Promise<AgentSession>;
}
```

Notes:
- `assistantMessage` is normalized text used by reply dispatch and step graders
- `rawOutput` is preserved for debugging
- `continueSession` maps to CLI-specific continuation flags or transcript replay fallback

### 3. Make conversation a first-class task mode

Keep support for simple single-turn tasks, but model them as the trivial case of the same runtime.

```ts
type TaskMode = 'single_turn' | 'conversation';
```

## Minimal Config API

Make `eval.ts` the primary format.

```ts
import { defineEval } from '@wix/pathgrade';

export default defineEval({
  defaults: {
    agent: 'claude',
    trials: 3,
    timeoutSec: 180,
  },
  tasks: [
    {
      name: 'ck-new-happy-path',
      mode: 'conversation',
      opener: 'Help me start a new project.',
      workspace: ['fixtures/app'],
      conversation: {
        replies: [
          { reply: 'I am building a tool for freelance designers.' },
          { when: /what is your goal/i, reply: 'Validate the idea quickly.' },
          { when: /target group/i, reply: 'Independent designers in Europe.' },
        ],
        completion: {
          maxTurns: 8,
          filesExist: ['artifacts/project-brief.md'],
        },
      },
      stepGraders: [
        { afterTurn: 1, type: 'llm_rubric', rubric: 'rubrics/asks-for-project.md' },
      ],
      graders: [
        { type: 'deterministic', run: 'bash tests/assert-brief.sh' },
      ],
    },
  ],
});
```

### Suggested public types

```ts
export interface EvalDefinition {
  defaults?: EvalDefaultsInput;
  tasks: EvalTaskInput[];
}

export interface EvalTaskInput {
  name: string;
  mode?: 'single_turn' | 'conversation';
  instruction?: string;
  opener?: string;
  workspace?: WorkspaceInput[];
  conversation?: ConversationInput;
  stepGraders?: StepGraderInput[];
  graders: GraderInput[];
}

export interface ConversationInput {
  replies?: ReplyRuleInput[];
  persona?: PersonaInput;
  completion?: CompletionInput;
}
```

## Migration Plan

### Phase 1: Fork and simplify runtime

1. Create `pathgrade` from the current repo.
2. Remove Docker code paths from the CLI and config defaults.
3. Keep current reporters and grader implementations with minimal changes.
4. Add `eval.ts` loading with `defineEval()`.

Success condition:
- existing single-turn examples run locally from `eval.ts`

### Phase 2: Introduce conversation runtime

1. Add `TrialRoot` and per-trial isolated HOME/XDG state.
2. Add `AgentSession` adapters for Claude, Codex, and Gemini.
3. Implement `ConversationRunner`.
4. Add scripted replies and completion detection.

Success condition:
- deterministic multi-turn eval passes for `ck-new`

### Phase 3: Add quality features

1. Add persona-backed simulated replies
2. Add step graders
3. Improve transcript viewer and browser report
4. Add migration command from `eval.yaml` to `eval.ts`

Success condition:
- conversation reports explain turn-by-turn behavior, not just final reward

## What To Reuse vs Replace

Reuse with light edits:
- graders
- reporters
- CLI argument parsing
- skill discovery/injection
- browser viewer

Replace early:
- provider abstraction
- single-turn eval runner
- YAML-first loader
- task temp-dir assembly that assumes Docker/test-script layout

## Risks

### Biggest technical risk

Agent CLI continuation is not identical across Claude, Codex, and Gemini.

Mitigation:
- define an adapter contract around `AgentSession`
- support transcript replay fallback where native continuation is weak
- test one agent end-to-end first, preferably Claude because your current work already leans there

### Biggest product risk

Trying to remain too compatible with upstream will slow the architecture cleanup.

Mitigation:
- keep file-level reuse, not behavior-level compatibility promises
- explicitly declare local-only, TS-first, multi-turn-first scope in the new repo README

## Recommended First Slice

Build the smallest version that proves the architecture:

1. `pathgrade` forked repo
2. `eval.ts` only
3. local trial root with isolated `HOME`
4. Claude adapter with start/reply session support
5. scripted replies only
6. one deterministic final grader
7. one example: `ck-new`

If that slice works, the rest is extension work. If it does not, you will find the real design issues early without carrying Docker and YAML baggage.
