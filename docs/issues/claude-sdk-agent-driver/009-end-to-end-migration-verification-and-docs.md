## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Finish the migration with the promised mocked end-to-end coverage and user-facing documentation updates. The final state should prove the full ask-user round trip, keep the real-SDK smoke coverage, and explain the new Claude SDK behavior and limitations to fixture authors and eval-running engineers.

This slice does not add new modules; it adds an integration test that exercises the four PRD-decomposed modules together, and updates user-facing docs.

Type: AFK

## Acceptance criteria

- [ ] Add one end-to-end integration test that drives the Claude SDK agent against a mocked SDK across multiple turns and verifies a full ask-user round trip.
- [ ] The integration test asserts ask_user tool-event shape, resolved bus snapshot, visible assistant messages, token usage, `costUsd`, and `agent_result.cost_usd`.
- [ ] Existing conversation runner, reaction loader, bus handler, and tool-event tests continue passing without fixture API changes.
- [ ] `tests/claude-sdk-smoke.test.ts` remains in the suite as a gated real-SDK regression check and is not replaced by mocks.
- [ ] User guide documentation covers `AskUserQuestion` unavailability inside subagents, Claude executable override, Claude Code system-prompt preset, hermetic versus CLI-faithful settings, and SDK auth environment variables.
- [ ] Install documentation calls out the SDK bundled binary footprint and override path for users who want a specific local Claude build.
- [ ] The package builds. All unit suites pass; the new mocked end-to-end test added in this slice passes; the existing conversation-runner / reaction-loader / bus-handler / tool-event suites pass unmodified; `tests/claude-sdk-smoke.test.ts` passes when an auth source is present and skips cleanly when none of the gated auth modes are available.

## Blocked by

- Blocked by local draft #001 (SDK Claude Turn Driver)
- Blocked by local draft #002 (SDK Message Projection Parity)
- Blocked by local draft #003 (Claude Token, Cost, And Error Telemetry)
- Blocked by local draft #004 (Live AskUserQuestion Happy Path)
- Blocked by local draft #005 (AskUserQuestion Batch And Freeform Answers)
- Blocked by local draft #006 (AskUserQuestion Decline And Unmatched Failures)
- Blocked by local draft #007 (Remove Claude Runtime-Policy Workaround)
- Blocked by local draft #008 (Delete Blocked-Prompt Synthesis Path)

## User stories addressed

- User story 31
- User story 35
- User story 37
