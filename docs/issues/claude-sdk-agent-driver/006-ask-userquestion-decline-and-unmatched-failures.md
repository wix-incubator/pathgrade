## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Handle all non-happy ask-user outcomes for the Claude SDK bridge. Declined reactions should become the SDK's deny shape, bus resolution failures should terminate cleanly, and unmatched questions should surface structured diagnostics that include the question text, batch id, and turn number.

Extends the **ask-user-bridge** module from #004 per PRD §Module decomposition, plus a small extension to `AskUserUnmatchedSignal` and `createAskUserHandler()`. No new module.

Type: AFK

## Acceptance criteria

- [ ] A declined ask-user batch returns `{ behavior: "deny", message: "User declined to answer" }` to the SDK.
- [ ] Ask-bus resolution rejection or timeout returns SDK deny with the error message and causes the conversation runner to report an error completion.
- [ ] `AskUserUnmatchedSignal` includes `questionTexts: string[]` in addition to batch id and turn number.
- [ ] Unmatched ask-user completion detail includes the turn number, batch id, and at least the first unmatched question text.
- [ ] `onUnmatchedAskUser` behavior remains compatible for `error`, `first-option`, and `decline`, including free-text/secret degradation to error where applicable.
- [ ] Tests cover declined answers, bus timeout/rejection, unmatched structured signal fields, and user-facing completion detail.

## Blocked by

- Blocked by local draft #004 (Live AskUserQuestion Happy Path)

## User stories addressed

- User story 8
- User story 29
