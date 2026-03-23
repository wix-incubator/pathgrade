# Pathgrade Conversation Runtime Foundation Plan

**Date:** 2026-03-23
**Status:** In Progress
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

## Verification Evidence

Verified immediately before commit `8c6f45f`:

- `npm test`
- `npm run build`

Result:

- 16 test files passed
- 152 tests passed
- TypeScript build passed

## Remaining Phase 2 Checklist

These are the remaining steps to fully close the Phase 2 runtime checkpoint described in the design doc:

- [ ] Remove Docker/provider branching from the main run path in `src/commands/run.ts`
- [ ] Remove Docker-specific staging and remaining Docker-first assumptions from runtime setup
- [ ] Add real session continuation behavior per agent adapter
  - Claude native continuation first
  - transcript fallback for agents without reliable native continuation
- [ ] Make local command execution abortable so runtime timeouts can stop child processes cleanly
- [ ] Remove Docker dependencies and leftover Docker surface area if no longer needed
- [ ] Verify the local-only runtime remains CI-safe after the Docker removal work

## Recommended Next Slice

Recommended next slice: **finish Phase 2 before starting the conversation runner**.

Order:

1. Remove Docker/provider branching from `src/commands/run.ts`
2. Simplify task staging to local-only assumptions
3. Add native continuation support and transcript fallback in the agent adapters
4. Add abortable local command execution
5. Remove Docker dependencies and re-verify build/tests

Rationale:

- The conversation runner depends on the runtime boundary being settled.
- If we build `conversationRunner` before finishing Phase 2, we risk rewriting orchestration code twice.

## Next Major Phase After That

After the remaining Phase 2 items are done, the next major slice is:

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
4. Execute the next unchecked item in order.

Suggested opener:

`Continue Pathgrade migration from docs/2026-03-23-conversation-runtime-foundation-plan.md. Read that file plus docs/2026-03-23-wix-fork-proposal.md and the Phase 2/3 sections of docs/2026-03-20-multi-turn-conversations-design.md, then execute the next unchecked item.`
