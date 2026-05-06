## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Remove the non-interactive runtime-policy workaround from Claude runs now that Claude has a reliable live ask-user transport. The policy infrastructure should remain intact for Codex exec and Cursor, but Claude turns should no longer receive the ask-user workaround text or report it as applied.

This is a pure deletion / capability flip on the Claude path; no module is added or restructured. The runtime-policy module itself stays in place to serve Codex (exec) and Cursor.

Type: AFK

## Acceptance criteria

- [ ] Claude session creation no longer prepends non-interactive runtime-policy text to first-turn prompts.
- [ ] Claude `AgentTurnResult.runtimePoliciesApplied` is preserved as an empty array.
- [ ] Codex exec and Cursor retain the existing non-interactive runtime-policy behavior and preflight protection.
- [ ] Conversation-time preflight treats Claude ask-user reactions as reachable because its transport is reliable.
- [ ] Tests assert Claude no longer receives the runtime-policy prompt and that Codex/Cursor behavior is unchanged.

## Blocked by

- Blocked by local draft #004 (Live AskUserQuestion Happy Path)
- Blocked by local draft #006 (AskUserQuestion Decline And Unmatched Failures)

## User stories addressed

- User story 24
- User story 30
