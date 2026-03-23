# Pathgrade Conversation Runtime Foundation Plan

**Date:** 2026-03-23
**Status:** Phase 2 Complete (working tree)
**Scope:** Phase 2 checkpoint after the local-first slice.

## Goal

Finish the runtime foundation needed for multi-turn evals while keeping the current single-turn flow working.

This checkpoint is concerned with the runtime boundary, not the full conversation loop yet.

## Context

- Product direction: [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-23-wix-fork-proposal.md)
- Architecture background: [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-20-multi-turn-conversations-design.md)
- Prior completed slice: [docs/2026-03-23-local-first-migration-plan.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-23-local-first-migration-plan.md)
- Foundation checkpoint landed in commit `8c6f45f`

## Slice Boundaries

This foundation slice was intentionally kept to 3 steps:

- [x] Add per-trial local isolation with `workspace`, `home`, `xdg`, and `tmp`
- [x] Introduce a session-capable agent boundary for future multi-turn support
- [x] Keep the current single-turn execution flow working through that new boundary

This slice did **not** add the conversation runner, scripted replies, completion logic, or step graders.

## What Landed

- `LocalProvider` now creates an isolated per-trial root and applies isolated runtime env vars during command execution.
- The core runtime now has a session-capable agent boundary with compatibility fallback for existing single-turn agents.
- Agent adapters now write prompt temp files under `TMPDIR` instead of a shared `/tmp` path.
- Existing single-turn eval execution still runs through `EvalRunner`.
- Focused tests were added for local isolation, session-capable runtime usage, and prompt temp-file behavior.

## Current Working Tree Progress

Additional Phase 2 work has been completed in the current worktree after commits `8c6f45f` and `cd1d75c`:

- [x] Remove Docker/provider branching from the main run path in `src/commands/run.ts`
- [x] Remove Docker-specific staging from `prepareTempTaskDir()`
- [x] Add real session continuation behavior per agent adapter
  - Claude uses native `-c` continuation
  - Gemini uses transcript accumulation fallback
  - Codex uses transcript accumulation fallback
- [x] Make local command execution abortable so agent timeouts can terminate child processes
- [x] Remove the remaining Docker CLI/docs/config surface
- [x] Reject deprecated `provider` and `docker` fields in `eval.yaml`
- [x] Remove `dockerode`, `tar-stream`, and `src/providers/docker.ts`
- [x] Rewrite the active architecture and setup docs around the local-only runtime

This completes the planned Phase 2 runtime cleanup in the current worktree.

## Verification Evidence

Verified immediately before commit `8c6f45f`:

- `npm test`
- `npm run build`

Result:

- 16 test files passed
- 152 tests passed
- TypeScript build passed

Verified again after the additional Phase 2 work above:

- `npm test`
- `npm run build`

Result:

- 16 test files passed
- 158 tests passed
- TypeScript build passed

Verified again after the final Docker cleanup and local-only config/doc updates:

- `npm test`
- `npm run build`

Result:

- 16 test files passed
- 160 tests passed
- TypeScript build passed

## Remaining Phase 2 Checklist

These were the remaining steps needed to fully close the Phase 2 runtime checkpoint described in the design doc:

- [x] Remove Docker/provider branching from the main run path in `src/commands/run.ts`
- [x] Remove Docker-specific staging and remaining Docker-first assumptions from runtime setup
- [x] Add real session continuation behavior per agent adapter
  - Claude native continuation first
  - transcript fallback for agents without reliable native continuation
- [x] Make local command execution abortable so runtime timeouts can stop child processes cleanly
- [x] Remove Docker dependencies and leftover Docker surface area if no longer needed
- [x] Verify the local-only runtime remains CI-safe after the Docker removal work

## Recommended Next Slice

Recommended next slice: **start the Phase 3 conversation runner**.

Order:

1. Introduce `conversationRunner` for multi-turn tasks
2. Add reply dispatch and transcript persistence across turns
3. Add completion checking and termination rules
4. Branch between single-turn and conversation task execution
5. Extend tests around scripted multi-turn fixtures before adding step graders

Rationale:

- The runtime foundation and cleanup work are now aligned around one local-only execution model.
- The next meaningful risk is no longer runtime drift; it is the conversation loop itself.

## Next Major Phase After That

After Phase 2, the next major slice is:

- `conversationRunner`
- reply dispatch
- completion checking
- task-mode branching between single-turn and conversation

That corresponds to Phase 3 in [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-20-multi-turn-conversations-design.md).

## Working Rules For Future Sessions

Use this file as the active migration checkpoint for post-local-first runtime work.

When a slice lands:

- update the completed checklist items
- record the landing commit
- record verification commands actually run
- add the next recommended slice
- keep unfinished work as unchecked items in execution order

If work moves beyond Phase 2, either update this file or create the next checkpoint doc and link it here.

## Session Handoff

For a fresh session, start with:

1. Read this file.
2. Read [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-23-wix-fork-proposal.md).
3. Read the Phase 2 and Phase 3 sections of [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/.worktrees/conversation-runtime-foundation/docs/2026-03-20-multi-turn-conversations-design.md).
4. Start the Phase 3 `conversationRunner` slice.

Suggested opener:

`Continue Pathgrade migration from docs/2026-03-23-conversation-runtime-foundation-plan.md. Read that file plus docs/2026-03-23-wix-fork-proposal.md and the Phase 3 sections of docs/2026-03-20-multi-turn-conversations-design.md, then implement the conversationRunner slice.`
