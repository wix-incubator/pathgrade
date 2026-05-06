# Claude SDK Agent Driver Migration Tracker

Source PRD: `docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## Merge model

All nine slices land on the `claude-sdk-agent-driver` branch (this branch — same one that holds the PRD and these issue drafts). `master` receives a single squashed PR after #009 passes verification. The PRD requires "no transport flag, no half-state" on `master`, so individual slices are not master-mergeable on their own — they accumulate on this branch and the squashed PR is the atomic unit visible to consumers. PRD docs and issue drafts ride along in the same squashed PR.

## Overall Status

- [x] 001 - SDK Claude Turn Driver
- [x] 002 - SDK Message Projection Parity
- [ ] 003 - Claude Token, Cost, And Error Telemetry
- [ ] 004 - Live AskUserQuestion Happy Path
- [ ] 005 - AskUserQuestion Batch And Freeform Answers
- [ ] 006 - AskUserQuestion Decline And Unmatched Failures
- [ ] 007 - Remove Claude Runtime-Policy Workaround
- [ ] 008 - Delete Blocked-Prompt Synthesis Path
- [ ] 009 - End-To-End Migration Verification And Docs

## Dependency Order

1. 001 can start immediately.
2. 002 follows 001.
3. 003 follows 002.
4. 004 follows 001 and 002.
5. 005 follows 004.
6. 006 follows 004.
7. 007 follows 004 and 006.
8. 008 follows 006 and 007.
9. 009 follows 001 through 008.

## Issue Drafts

| Draft | Type | Status | Blocked By | File |
| --- | --- | --- | --- | --- |
| 001 - SDK Claude Turn Driver | AFK | Done | None | `001-sdk-claude-turn-driver.md` |
| 002 - SDK Message Projection Parity | AFK | Done | 001 | `002-sdk-message-projection-parity.md` |
| 003 - Claude Token, Cost, And Error Telemetry | AFK | Not started | 002 | `003-claude-token-cost-error-telemetry.md` |
| 004 - Live AskUserQuestion Happy Path | AFK | Not started | 001, 002 | `004-live-ask-userquestion-happy-path.md` |
| 005 - AskUserQuestion Batch And Freeform Answers | AFK | Not started | 004 | `005-ask-userquestion-batch-and-freeform-answers.md` |
| 006 - AskUserQuestion Decline And Unmatched Failures | AFK | Not started | 004 | `006-ask-userquestion-decline-and-unmatched-failures.md` |
| 007 - Remove Claude Runtime-Policy Workaround | AFK | Not started | 004, 006 | `007-remove-claude-runtime-policy-workaround.md` |
| 008 - Delete Blocked-Prompt Synthesis Path | AFK | Not started | 006, 007 | `008-delete-blocked-prompt-synthesis-path.md` |
| 009 - End-To-End Migration Verification And Docs | AFK | Not started | 001-008 | `009-end-to-end-migration-verification-and-docs.md` |

## Progress Log

| Date | Update |
| --- | --- |
| 2026-05-06 | Broke the PRD into nine AFK vertical-slice issue drafts and created this tracker. |
| 2026-05-06 | Tightened drafts after readiness review: documented merge model (single squashed PR after #009), pinned ToolEvent.arguments boundary between #002 and #004, added missing #001 acceptance items (SDK pin, CLAUDE_CONFIG_DIR, env layering, autoMemoryEnabled), declared interim behavior between sequential slices, locked snapshot back-compat to read-only, and added module-decomposition pointers to each slice. |
| 2026-05-06 | Renamed branch `claude-sdk-agent-driver-prds` → `claude-sdk-agent-driver`. Implementation accumulates on this branch directly rather than on a separately-cut feature branch. |
| 2026-05-06 | Landed #001. Modules: `src/providers/sandboxed-claude-spawn.ts`, `src/providers/mcp-config.ts` (`loadMcpServersForSdk`), `src/agents/claude/sdk-options.ts`, `src/agents/claude/can-use-tool-placeholder.ts`, plus rewritten `src/agents/claude.ts`. Tests: `tests/sandboxed-claude-spawn.test.ts`, `tests/mcp-config.test.ts` (loader block), `tests/claude-sdk-options.test.ts`, `tests/claude-can-use-tool-placeholder.test.ts`, `tests/claude-sdk-driver.test.ts` (50 new tests, all green; full suite 1083 passed / 1 skipped file / 7 skips). Removed obsolete CLI-driver tests (`tests/claude-ask-batch-emit.test.ts` deleted; ClaudeAgent describe block + Claude-specific traceOutput case stripped from `tests/agents.test.ts`). Legacy `extractClaudeStreamJsonEvents` export retained pending #002's projector that supersedes it. |
| 2026-05-06 | **PRD deviation logged at #001 land time.** PRD §SDK option choices and the §Pre-implementation verifications block claim `Options.autoMemoryEnabled?: boolean` exists at `sdk.d.ts:4740` against SDK `0.2.100`. Against the installed SDK `0.2.117`, the field at `sdk.d.ts:4740` lives on the `Settings` interface (the on-disk `~/.claude/settings.json` shape), not on `Options` — passing `{ autoMemoryEnabled: false }` through `Options` is a TypeScript error. The hermetic-default intent (User Story #40) is upheld in #001 by two other mechanisms already wired: (a) `CLAUDE_CONFIG_DIR` is set to a per-trial scratch dir under the workspace, redirecting any auto-memory writes to disposable storage; (b) `settingSources: ['project']` excludes the `'user'` scope, so the host-level `~/.claude/settings.json`'s `autoMemoryEnabled` (and other user-scope state) does not load. The deviation is documented inline in `src/agents/claude/sdk-options.ts` and pinned in the test (`buildClaudeSdkOptions` asserts `autoMemoryEnabled` is intentionally absent from `Options`). If a future SDK release re-exposes `Options.autoMemoryEnabled`, set it to `false` there and remove the note. |
| 2026-05-06 | Landed #002. New module: `src/agents/claude/sdk-message-projector.ts` (pure typed-message → `AgentTurnResult` projector). `src/agents/claude.ts` now wires `projectSdkMessages` through `runTurn` (threading `turnNumber` and the cached `firstMessage`), and the legacy NDJSON helper `extractClaudeStreamJsonEvents` is deleted along with its unused imports (`TOOL_NAME_MAP`, `buildSummary`, `enrichSkillEvents`, `ToolEvent`). New tests: `tests/claude-sdk-projector.test.ts` (32 cases: empty stream, session-id flow, assistant-text accumulation, totalized + cache token usage, every documented `SDKResultError` subtype as `exitCode 1`, tool-use → ToolEvent mapping with structured-input preservation, `Skill` / SKILL.md skill enrichment, slash-command synthetic `use_skill`, AskUserQuestion projection with `answerSource: 'unknown'` boundary stamp for #004, runtime-policies-applied empty-array invariant, and NDJSON-trace surface). `tests/tool-events.test.ts` pruned of the legacy `extractClaudeStreamJsonEvents` describe block (~180 lines). Test-fixture cleanup nit: `toolUseID: 'test'` added to `ToolPermissionContext` fixtures in `tests/claude-can-use-tool-placeholder.test.ts` and `tests/claude-sdk-driver.test.ts` so standalone `tsc --noEmit` is now clean. Full suite 1102 passed / 7 skipped (vs 1083 baseline; +19 net). `tsc --noEmit` and `yarn build` both green. |

## Completion Notes

Use this section to record cross-slice decisions, verification results, or follow-up issues that emerge during implementation.

- **#001 land notes (2026-05-06).**
  - The deleted post-hoc `buildAskBatchFromClaudeDenials` call site in `src/agents/claude.ts` is gone, but the helper itself (`src/sdk/ask-bus/parsers.ts`) and its test (`tests/ask-batch-parity.test.ts`) remain, since the helper still parses Codex denial shapes too. PRD §Deletions tracks the full helper removal under #008.
  - `extractClaudeStreamJsonEvents` is still exported from `src/agents/claude.ts` because `tests/tool-events.test.ts` consumes it. #002 ships the SDK message projector and replaces those tests; the legacy export should be removed in the same slice. **(Cleared by #002 — see #002 land notes.)**
  - `collectAuthEnv()` in the rewritten `claude.ts` is a no-op stub today: workspace-prep credential resolution still runs through `prepareWorkspace → resolveCredentials`, and the SDK driver does not yet receive that env. End-to-end auth pass-through into `Options.env` becomes live work for #009 (which verifies the full migrated path) — for #001 the option-builder side is unit-tested with synthetic auth env, the spawn-module side is unit-tested with both auth and host vars, and the smoke test (`tests/claude-sdk-smoke.test.ts`) already covers real-SDK auth via `APP_ANTHROPIC_*`.
  - `autoMemoryEnabled` deviation: see Progress Log entry. Hermetic-default intent preserved via `CLAUDE_CONFIG_DIR` + `settingSources: ['project']`.

- **#002 land notes (2026-05-06).**
  - `extractClaudeStreamJsonEvents` removed from `src/agents/claude.ts`; the SDK driver now projects exclusively from typed `SDKMessage` values via `projectSdkMessages` (`src/agents/claude/sdk-message-projector.ts`). The legacy NDJSON describe block in `tests/tool-events.test.ts` was removed; the replacement coverage lives in `tests/claude-sdk-projector.test.ts`.
  - **Boundary with #004 stamped on the envelope.** `AskUserQuestion` tool-use events project to `ToolEvent.arguments = { ...AskUserQuestionInput, answerSource: 'unknown' }`. The bridge in #004 attaches answer values + a `'reaction' | 'fallback' | 'declined'` source onto this same envelope; #002 never mints answer values or a non-`unknown` source, and never reaches into the bus. Snapshot scorers see a stable `questions / headers / options / multiSelect` shape today, will see a richer one once #004 lands — no envelope rename required.
  - **`traceOutput` populated from typed messages.** The projector serializes the typed `SDKMessage[]` as NDJSON on `AgentTurnResult.traceOutput`, so per-turn diagnostic tooling that historically grepped the stream still has a recognizable surface, but the projection itself never consults the string back. `tests/agents.test.ts` already documents that `traceOutput` is no longer the projection surface for Claude post-migration, so this is purely a debug-affordance preservation, not a contract.
  - **`runtimePoliciesApplied` is the empty array, always.** PRD §Capabilities and runtime policies flips Claude's interactive-question transport from `'noninteractive'` to `'reliable'` (in #007). #002 already preserves the projector-side invariant: even on error turns, no runtime policy is reported as applied for Claude.
  - **Cache-token breakdown deferred to #003.** The projector totalizes `inputTokens` (uncached + `cache_creation_input_tokens` + `cache_read_input_tokens`) per the existing pathgrade convention, but does not yet expose the additive `cacheCreationInputTokens` / `cacheReadInputTokens` breakdown fields the PRD §Token-and-cost telemetry section requires; #003 adds those fields to `AgentTurnResult` and threads them through. The `costUsd` field (also §Token-and-cost telemetry) is similarly #003's slice.
