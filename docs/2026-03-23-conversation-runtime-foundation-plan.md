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

- [ ] Secure Remote LLM Backend for persona replies and `llm_rubric`
- [ ] `conversation.step_graders`
- [ ] conversation-aware `--validate` support
- [ ] richer report/viewer rendering for conversation summaries

Current behavior for deferred pieces:

- Remote LLM support is documented separately in:
  - [docs/2026-03-23-mcp-s-remote-llm-prd.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-prd.md)
  - [docs/2026-03-23-mcp-s-remote-llm-spec.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-spec.md)
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

Recommended next slice: **Secure Remote LLM Backend**.

Order:

1. Thread one trial-scoped LLM execution context through `EvalRunner`, `ConversationRunner`, persona calls, and `llm_rubric`
2. Add a backend-aware `callLLM(...)` boundary for `persona_reply` and `llm_rubric`
3. Implement a host-scoped `mcp-s-cli` client with stdin-only transport, host-auth resolution, version checks, and timeouts
4. Keep the main agent loop local while preserving explicit local fallback for CI and controlled environments
5. Ship the employee secure-mode entrypoint/onboarding path and extend tests around backend selection, remote response parsing, and host-env behavior

Rationale:

- Persona fallback is now in place, and it already depends on shared LLM infrastructure.
- The new security constraint changes priority: employee-machine usage is blocked until persona replies and `llm_rubric` stop requiring local provider API keys.
- The remote backend is the next slice that unblocks broader adoption without redesigning the local agent runtime.

## Next Major Phase After That

After the remote backend slice, the next major slices remain:

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
3. Read [docs/2026-03-23-mcp-s-remote-llm-prd.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-prd.md).
4. Read [docs/2026-03-23-mcp-s-remote-llm-spec.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-spec.md).
5. Read the Phase 4 and 5 sections of [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-20-multi-turn-conversations-design.md).
6. Continue with the remote backend slice unless priorities have changed.

Suggested opener:

`Continue Pathgrade migration from docs/2026-03-23-conversation-runtime-foundation-plan.md. Read that file, docs/2026-03-23-wix-fork-proposal.md, docs/2026-03-23-mcp-s-remote-llm-prd.md, docs/2026-03-23-mcp-s-remote-llm-spec.md, and the Phase 4/5 sections of docs/2026-03-20-multi-turn-conversations-design.md, then implement the Remote LLM Backend slice.`
