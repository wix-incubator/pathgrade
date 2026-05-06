## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Delete the deprecated Claude blocked-prompt synthesis model and the code that replayed denied `AskUserQuestion` calls as synthetic user turns. After this slice, the codebase should have one coherent ask-user model for Claude: live SDK tool calls through the ask-bus.

This is a deletion-only slice — no module is added. It removes the pre-SDK CLI-driver path, the blocked-prompt queue, the denial-reconstruction helpers, and the PATH-search shim-avoidance resolver named in PRD §Deletions.

Type: AFK

## Acceptance criteria

- [ ] `BlockedInteractivePrompt`, `blockedPrompts`, and `VisibleAssistantMessageSource` value `blocked_prompt` are removed from active source types and agent turn results.
- [ ] The pending blocked-prompt queue and its dispatch branches are removed from conversation and chat flows.
- [ ] Claude denial-reconstruction helpers, formatted blocked-prompt helpers, and post-hoc Claude ask-batch parser code are removed.
- [ ] Tests dedicated only to blocked-prompt queue behavior are deleted or rewritten around the live ask-user contract.
- [ ] Runtime writes of legacy `blocked_prompt` fields are dropped (no new code paths emit them); snapshot/log **readers** keep read-only parsing of those fields so historical snapshots predating the migration still load. This pins the degree of freedom: drop on the write side, preserve on the read side. User Story #33 (snapshot stability for historical run-snapshot comparisons) is satisfied through the read-only parser, not through continued runtime emission.
- [ ] The old CLI stream parser, session-id shell sanitization, and PATH-search shim-avoidance resolver are removed with the old driver path.
- [ ] The full test suite no longer references deprecated blocked-prompt runtime concepts except intentional legacy snapshot compatibility tests.

## Blocked by

- Blocked by local draft #006 (AskUserQuestion Decline And Unmatched Failures)
- Blocked by local draft #007 (Remove Claude Runtime-Policy Workaround)

## User stories addressed

- User story 25
- User story 32
