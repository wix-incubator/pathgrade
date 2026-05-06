## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Implement the live `AskUserQuestion` handshake through the SDK `canUseTool` callback. When Claude asks a structured question, Pathgrade should emit a live ask batch through the existing ask-bus, resolve it from `whenAsked` reactions in real time, return the answer to Claude as the tool result, and let Claude continue the same turn down the chosen branch.

Type: AFK

## Acceptance criteria

- [ ] `ClaudeAgent.createSession()` requires an ask-bus for live ask-user batches and fails fast when one is missing.
- [ ] The SDK `canUseTool` callback auto-allows non-`AskUserQuestion` tools.
- [ ] `AskUserQuestion` input is converted into a live `AskBatch` with source `claude`, source tool `AskUserQuestion`, turn number, questions, headers, options, and multi-select metadata.
- [ ] Reaction answers are returned to the SDK as `{ behavior: "allow", updatedInput: { ...input, answers } }` using the SDK's documented `answers` map shape.
- [ ] The resulting transcript/tool events show the literal `AskUserQuestion` tool with structured input and the supplied answer source.
- [ ] Claude's capability table marks `interactiveQuestionTransport` as `reliable`.
- [ ] Tests cover one full mocked SDK turn where a reaction answer is consumed and the assistant continues in the same turn.

## Blocked by

- Blocked by local draft #001 (SDK Claude Turn Driver)
- Blocked by local draft #002 (SDK Message Projection Parity)

## User stories addressed

- User story 1
- User story 2
- User story 3
- User story 4
- User story 5
- User story 28
- User story 30
- User story 36
