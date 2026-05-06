## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Add Claude SDK telemetry projection for cache-token breakdowns, per-turn cost, run-level conversation cost, and typed SDK error result subtypes. This should preserve current total-token accounting while adding optional fields for the extra information exposed by the SDK.

Type: AFK

## Acceptance criteria

- [ ] `AgentTurnResult` includes optional `cacheCreationInputTokens`, `cacheReadInputTokens`, and `costUsd` fields.
- [ ] Claude `inputTokens` remains totalized as uncached input plus cache-creation input plus cache-read input.
- [ ] Claude SDK result messages populate cache-token breakdown fields and `costUsd` when present.
- [ ] `agent_result` log entries include `cost_usd` when the turn result has `costUsd`.
- [ ] Conversation execution accumulates Claude turn costs into `TrialResult.conversation_cost_usd` and emits conservative total cost only when all included components are known.
- [ ] SDK error subtypes `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, and `error_max_structured_output_retries` are distinguished from successful turns without regex parsing.
- [ ] Tests cover successful usage, cache-token totalization, cost logging, run-level cost accumulation, and each typed SDK error subtype.

## Blocked by

- Blocked by local draft #002 (SDK Message Projection Parity)

## User stories addressed

- User story 17
- User story 18
- User story 19
