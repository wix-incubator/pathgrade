## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Delete the deprecated Claude blocked-prompt synthesis model and the code that replayed denied `AskUserQuestion` calls as synthetic user turns. After this slice, the codebase should have one coherent ask-user model for Claude: live SDK tool calls through the ask-bus.

This is a deletion-only slice — no module is added. It removes the pre-SDK CLI-driver path, the blocked-prompt queue, the denial-reconstruction helpers, and the PATH-search shim-avoidance resolver named in PRD §Deletions.

Type: AFK

## Acceptance criteria

- [x] `BlockedInteractivePrompt`, `blockedPrompts`, and `VisibleAssistantMessageSource` value `blocked_prompt` are removed from active source types and agent turn results. *(Deviation: `LogEntry.assistant_message_source` retains `'blocked_prompt'` as a side-B union member — `VisibleAssistantMessageSource | 'blocked_prompt'` — purely for read-side compat with legacy snapshots, per criterion 5. The active type `VisibleAssistantMessageSource` itself is narrowed to `'assistant_message'` and `AgentTurnResult.visibleAssistantMessageSource` carries the narrow type, so no writer can produce the legacy literal.)*
- [x] The pending blocked-prompt queue and its dispatch branches are removed from conversation and chat flows.
- [x] Claude denial-reconstruction helpers, formatted blocked-prompt helpers, and post-hoc Claude ask-batch parser code are removed.
- [x] Tests dedicated only to blocked-prompt queue behavior are deleted or rewritten around the live ask-user contract.
- [x] Runtime writes of legacy `blocked_prompt` fields are dropped (no new code paths emit them); snapshot/log **readers** keep read-only parsing of those fields so historical snapshots predating the migration still load. This pins the degree of freedom: drop on the write side, preserve on the read side. User Story #33 (snapshot stability for historical run-snapshot comparisons) is satisfied through the read-only parser, not through continued runtime emission.
- [x] The old CLI stream parser, session-id shell sanitization, and PATH-search shim-avoidance resolver are removed with the old driver path. *(Deviation: pre-completed by earlier slices. `extractClaudeStreamJsonEvents` was deleted in #002, `resolveClaudeExecutable` was deleted in #001 along with the CLI shell command construction that owned the session-id interpolation. The only `sanitizeSessionId` left in the repo is `src/agents/cursor.ts:271` — Cursor's own resume-flag escaper for its still-exec-shell-based driver, scoped to Cursor and out of scope for the Claude path.)*
- [x] The full test suite no longer references deprecated blocked-prompt runtime concepts except intentional legacy snapshot compatibility tests.

## Blocked by

- Blocked by local draft #006 (AskUserQuestion Decline And Unmatched Failures)
- Blocked by local draft #007 (Remove Claude Runtime-Policy Workaround)

## User stories addressed

- User story 25
- User story 32
