## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Project the SDK's typed message stream into Pathgrade's existing turn-result and tool-event contracts. A Claude SDK turn should produce the same externally visible assistant text, tool events, skill enrichment, slash-command skill detection, session metadata, and snapshot-compatible ask_user projection that existing scorers and reporters expect.

Type: AFK

## Acceptance criteria

- [ ] SDK init, assistant, tool-use, and result messages are consumed through a typed projector instead of NDJSON parsing.
- [ ] `AgentTurnResult.assistantMessage`, `visibleAssistantMessage`, `rawOutput`, `traceOutput`, `sessionId`, `toolEvents`, and `runtimePoliciesApplied` are populated from SDK messages.
- [ ] Tool-use blocks keep structured input data and continue to map through existing `TOOL_NAME_MAP`, `buildSummary`, and `enrichSkillEvents` behavior.
- [ ] Slash-command invoked skills still emit a synthetic `use_skill` event when the command name appears in SDK init skills.
- [ ] The ask_user `ToolEvent` arguments shape remains stable for run snapshots and scorer consumers.
- [ ] Tests feed representative SDK message sequences and assert the public `AgentTurnResult` and tool-event output, including skill and slash-command cases.

## Blocked by

- Blocked by local draft #001 (SDK Claude Turn Driver)

## User stories addressed

- User story 3
- User story 16
- User story 22
- User story 27
- User story 33
