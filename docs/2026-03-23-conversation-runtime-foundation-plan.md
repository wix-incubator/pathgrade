# Pathgrade Conversation Runtime Foundation Plan

**Date:** 2026-03-23
**Status:** Phase 3 Persona Fallback Complete (working tree)
**Scope:** Runtime checkpoint after the persona-backed reply fallback slice.

## Goal

Finish the runtime foundation needed for multi-turn evals while keeping the current single-turn flow working.

This checkpoint covers the first usable conversation loop, not the full multi-turn feature set.

## Context

- Product direction: [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-wix-fork-proposal.md)
- Architecture background: [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-20-multi-turn-conversations-design.md)
- Prior completed slice: [docs/2026-03-23-local-first-migration-plan.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-local-first-migration-plan.md)
- Earlier runtime cleanup landed in commits `8c6f45f` and `cd1d75c`

## Phase 2 Summary

Phase 2 is complete.

Completed runtime cleanup:

- [x] Add per-trial local isolation with `workspace`, `home`, `xdg`, and `tmp`
- [x] Introduce a session-capable agent boundary for future multi-turn support
- [x] Keep the current single-turn execution flow working through that new boundary
- [x] Remove Docker/provider branching from the main run path in `src/commands/run.ts`
- [x] Remove Docker-specific staging from runtime setup
- [x] Add real session continuation behavior per agent adapter
  - Claude uses native `-c` continuation
  - Gemini uses transcript accumulation fallback
  - Codex uses transcript accumulation fallback
- [x] Make local command execution abortable so agent timeouts can terminate child processes
- [x] Remove the remaining Docker CLI/docs/config surface
- [x] Reject deprecated `provider` and `docker` fields in `eval.yaml`
- [x] Remove `dockerode`, `tar-stream`, and `src/providers/docker.ts`
- [x] Rewrite the active architecture and setup docs around the local-only runtime

## Phase 3 Foundation Slice

This slice implemented the smallest safe version of the conversation runner foundation:

- [x] Introduce `conversationRunner` for multi-turn tasks
- [x] Add scripted reply dispatch and transcript persistence across turns
- [x] Add completion checking and turn termination rules
- [x] Branch between single-turn and conversation execution while keeping the current single-turn flow working
- [x] Extend tests around scripted multi-turn fixtures

## What Landed

- Added `src/conversationRunner.ts` persona fallback support after scripted reply matching and queue exhaustion.
- Added conversation-aware config types and resolution for:
  - `conversation.opener`
  - `conversation.completion`
  - scripted `conversation.replies`
  - `conversation.persona`
- Added `src/persona.ts` persona prompt construction and reply generation.
- Added `src/utils/llm.ts` shared LLM calling infrastructure used by persona replies and `llm_rubric`.
- Updated `EvalRunner` to branch between single-turn and conversation execution.
- Preserved the existing single-turn run path and grading flow.
- Added transcript logging for:
  - opener and scripted user replies
  - persona-generated user replies
  - per-turn assistant messages
  - turn-scoped command execution
  - conversation completion reason
- Added separate persona token accounting in `TrialResult`.
- Added completion handling for:
  - `signal`
  - `done_phrase`
  - `max_turns`
  - `no_replies`
  - `timeout`
  - `error`
- Updated `run.ts` to pass conversation tasks through with conversation timeout precedence.
- Updated `llm_rubric` transcript construction to include the full multi-turn conversation when conversation logs are present.

## Deliberate Deferrals

The following items are still intentionally deferred after this slice:

- [ ] `conversation.step_graders`
- [ ] conversation-aware `--validate` support
- [ ] richer report/viewer rendering for conversation summaries

Current behavior for deferred pieces:

- `conversation.step_graders` are rejected during config validation
- `--validate` rejects conversation tasks

## Verification Evidence

Verified before this checkpoint handoff:

- `npm test`
- `npm run build`

Result:

- 16 test files passed
- 173 tests passed
- TypeScript build passed

## Recommended Next Slice

Recommended next slice: **step graders**.

Order:

1. Allow `conversation.step_graders` in config resolution
2. Run configured grader sets after the requested turn numbers
3. Persist step grader results in transcript/session logs and `TrialResult`
4. Keep end-of-conversation graders and reward calculation working unchanged
5. Extend tests for mid-conversation grading and failure reporting

Rationale:

- Persona fallback is now in place, so the next product gap is checking workflow compliance before the final artifact exists.
- Step graders are the next Phase 3 capability needed to verify conversational skills follow their intended turn-by-turn structure.

## Next Major Phase After That

After step graders, the next major slices remain:

- step graders
- deeper transcript/reporting support
- conversation-aware browser/CLI reporting

That corresponds to later phases in [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-20-multi-turn-conversations-design.md).

## Working Rules For Future Sessions

Use this file as the active migration checkpoint for post-local-first runtime work.

When a slice lands:

- update the completed checklist items
- record verification commands actually run
- add the next recommended slice
- keep unfinished work as unchecked items in execution order
- note any deliberate deferrals explicitly

If work moves well beyond this checkpoint, either update this file or create the next checkpoint doc and link it here.

## Session Handoff

For a fresh session, start with:

1. Read this file.
2. Read [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-wix-fork-proposal.md).
3. Read the Phase 3 sections of [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-20-multi-turn-conversations-design.md).
4. Continue with the step grader slice unless priorities have changed.

Suggested opener:

`Continue Pathgrade migration from docs/2026-03-23-conversation-runtime-foundation-plan.md. Read that file plus docs/2026-03-23-wix-fork-proposal.md and the Phase 3 step grader section of docs/2026-03-20-multi-turn-conversations-design.md, then implement step graders.`
