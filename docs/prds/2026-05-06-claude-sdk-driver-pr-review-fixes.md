# Claude SDK Driver — PR Review Fixes

## Problem Statement

The Claude Agent SDK driver migration (PR landing as a squashed commit on the `claude-sdk-agent-driver` branch, slices #001-#010) shipped four defects that pre-merge review surfaced. Three were flagged by the external reviewer; the fourth was a latent observability gap discovered while grilling the reviewer's findings:

- **Documented `createAgent({ env })` injection silently dropped.** The Claude SDK driver puts only `ANTHROPIC_*` keys onto `Options.env`, so any user-supplied env values reaching the workspace via `createAgent({ env })` — documented behavior per `docs/USER_GUIDE.md` — never reach the SDK subprocess. The pre-SDK CLI driver routed through `ws.exec`, which carried the full curated `Workspace.env`, so this is a regression introduced by the migration.
- **Sandbox HOME and TMPDIR no longer reach the subprocess.** Same root cause as above. Functionally muted for Claude config (the driver sets `CLAUDE_CONFIG_DIR` explicitly so HOME is irrelevant for SDK config lookup), but tools that the model invokes (Bash, Edit) inherit the sandbox's tmp/home isolation only via env, and the regression breaks that isolation.
- **`ClaudeAgent.run()` override unconditionally throws.** The override calls `createSession` with no session options; `createSession` requires an `askBus` and throws fast when one is absent. No in-tree caller invokes `run()`, but the override misleadingly *appears* to support single-shot execution and dies with an "askBus required" error rather than the base class's diagnostic "Agent must implement createSession() or run()".
- **Slash-command `use_skill` event re-synthesizes on every turn.** The driver caches the conversation's first user message and passes it to the projector on every turn. The projector synthesizes a `use_skill` tool event whenever (cached firstMessage starts with `/<name>`) AND (current turn's init message lists `<name>`). The Claude SDK emits a fresh `init` system message on every `query()` call (each turn spawns a fresh subprocess), so on turn 2+ the synthesizer fires again for the same skill activation. The legacy NDJSON parser was deliberately gated to turn 1; this PR silently flipped that. The dropped semantic corrupts judge prompts (`buildJudgePrompt` includes raw tool events with no dedupe) and contaminates per-turn `AgentTurnResult.toolEvents` consumed by every scorer.
- **Latent observability gap on ask-bus rejection.** When the ask-bus rejects a question (timeout, missing subscriber, handler throw), the driver throws *before* projecting the SDK message stream. The throw skips `pushModelAgentMessage`, dropping five separate log surfaces: `priorSessionId` for the next turn's resume, `toolEvents`, the `model_agent_result` log entry with `traceOutput`, `ask_batch` log entries (unique to this code path), and turn timings/details. Evaluation runs that hit a bus rejection lose visibility into what the agent tried to do before being killed.

## Solution

A single un-numbered fix-while-rebasing patch to the `claude-sdk-agent-driver` branch, absorbed by the squash before merge to master. The patch makes four changes:

1. The Claude SDK driver builds `Options.env` by spreading the workspace's resolved runtime env wholesale, then layering driver-owned hermetic overrides on top. The auth-only pluck helper is deleted. `createAgent({ env })`, sandbox HOME/TMPDIR, and ANTHROPIC_* credentials all flow through the same path.
2. The `ClaudeAgent.run()` override is deleted; the base class's diagnostic throw replaces it.
3. The driver passes the current turn's user message to the projector only on turn 1; on subsequent turns it passes `undefined`. The cached `firstMessage` driver state is deleted. The projector's behavior is unchanged.
4. The bridge-rejection path returns an error `AgentTurnResult` (with `exitCode = 1`, the new `'bus_rejection'` error subtype, the bridge error message, and the projected partial trace including the SDK-reported `session_id`) instead of throwing. The conversation loop's exit-code throw moves from `AgentImpl.sendTurn` to `runConversation` *after* `pushModelAgentMessage` runs, so the partial-turn log pipeline (`ask_batch`, `model_agent_result`, turn timings/details) captures the rejected turn before the throw propagates. The `errorSubtype` union widens by one value in the type contract.

The squashed migration commit reaches master in a self-consistent state. No follow-up PR is needed.

## User Stories

1. As a Pathgrade user, I want to pass `createAgent({ env: { MY_VAR: 'value' } })` and have `MY_VAR` reach the Claude agent's process, so that the documented env injection contract is honored for all agents.
2. As a Pathgrade user, I want sandbox isolation of HOME and TMPDIR to apply to the Claude agent's subprocess, so that tool invocations the model makes (Bash, Edit, file writes) cannot accidentally read or write the host user's home directory.
3. As a Pathgrade user, I want eval reproducibility across machines and CI, so that ambient host env state cannot silently change my eval results.
4. As a Pathgrade user evaluating slash-command skills (e.g. `/tdd`, `/ck-handoff`), I want exactly one `use_skill` event per skill activation, so that judge prompts and scorers see honest tool history rather than synthesized duplicates.
5. As a developer of an LLM-judge scorer, I want `ctx.toolEvents` to reflect events that actually happened, so that my rubric does not reward the agent for activations it did not make.
6. As a developer maintaining the Claude SDK driver, I want a single canonical env composition pipeline (workspace → runtime → `Options.env`), so that future env-related work has one place to change and not three.
7. As a developer, I want clear error messages when calling unsupported APIs, so that "ClaudeAgent does not support `run()`" does not present as "askBus required" — the latter implies a missing argument the caller could supply, but in fact `run()` cannot work for this driver.
8. As a developer, I want errors during a turn to preserve the partial turn trace, so that I can diagnose what the agent attempted before the failure.
9. As a developer running evals against the bus rejection path (timeout, declined ask-user batches), I want the resulting log to contain the partial `toolEvents`, `ask_batch` entries, and `model_agent_result` for that turn, so that the failure mode is observable in the same shape as a successful turn — just with `exitCode = 1`.
10. As a developer, I want resumed sessions on subsequent turns to use the most recent `session_id` reported by the SDK, even when an ask-bus rejection occurred, so that downstream turns continue from the correct conversation state instead of from a stale prior session.
11. As a downstream consumer of `AgentTurnResult.toolEvents`, I want per-turn tool events to reflect only that turn's actions, so that aggregating events across turns does not double-count slash-command activations.
12. As a Pathgrade contributor reviewing the squashed migration commit on master, I want the migration to ship correct, so that `git bisect` does not point at a known-broken intermediate state.
13. As a Pathgrade maintainer, I want defect repairs against an in-flight branch to absorb into the squash without creating numbered slices, so that the slice-numbering convention stays meaningful for planned PRD work.
14. As a developer, I want the `firstMessage` driver state removed entirely (rather than gated), so that the dead variable cannot be re-used incorrectly in a future change.
15. As an external reviewer of the Claude SDK driver, I want the comment block that argues "we intentionally pluck only the auth keys" replaced with one that documents the wholesale-spread + hermetic-override pattern, so that future readers do not re-derive the wrong conclusion from a stale design rationale.
16. As a Pathgrade user who set `CLAUDE_CONFIG_DIR` via `createAgent({ env })`, I want my value to be silently overridden by the driver-owned hermetic value, so that per-trial isolation cannot be weakened by user env injection. (This is a non-regression: the existing override-after-spread pattern preserves the invariant.)
17. As a developer running a multi-turn conversation that begins with a slash command, I want the synthesized `use_skill` event to appear once on turn 1 and never again, matching the legacy NDJSON parser's behavior.
18. As a developer running a multi-turn conversation that does not begin with a slash command, I want no synthesized `use_skill` events on any turn, so that a non-skill conversation is not contaminated by the synthesis pathway.
19. As a developer running a single-turn conversation that begins with a slash command, I want exactly one synthesized `use_skill` event on the first and only turn, preserving existing behavior for the common eval case.

## Implementation Decisions

### Module: Claude SDK driver (`src/agents/claude.ts`)

- The driver no longer maintains a cached `firstMessage` field. The variable is deleted along with the line that captures it on first use.
- The driver passes the current turn's `message` to the projector under the gate `turnNumber === 1 ? message : undefined`. This mirrors the legacy CLI driver's `isFirstTurn ? instruction : undefined` shape verbatim.
- The driver's auth-only env helper is deleted. The driver passes `getRuntimeEnv(runtime)` directly to the SDK options builder under a new field name (`runtimeEnv` rather than `authEnv`) so the call site is honest about what flows through.
- The driver's `run()` override is deleted. `ClaudeAgent` inherits `BaseAgent.run()`, which throws "Agent must implement createSession() or run()" — an honest diagnostic that points the caller at the right API.
- The bridge-rejection path no longer throws. The driver checks `bridge.lastError()` *after* projection, assigns `priorSessionId` from `projected.sessionId` *before* returning (so the next turn's `Options.resume` points at the rejected turn's session), then constructs an error `AgentTurnResult` carrying `exitCode = 1`, `errorSubtype: 'bus_rejection'`, `rawOutput` containing the bridge error message, and the projected partial trace (`toolEvents`, `traceOutput`). The driver returns this result instead of throwing.

### Module: Claude SDK options builder (`src/agents/claude/sdk-options.ts`)

- The `ClaudeSdkOptionsInputs.authEnv` field is renamed `runtimeEnv` to reflect the wholesale workspace env it now carries.
- `buildClaudeSdkOptions` constructs `Options.env` as: spread `runtimeEnv` first, then assign driver-owned `CLAUDE_CONFIG_DIR` to the per-trial scratch directory under the workspace. The CLAUDE_CONFIG_DIR-after-spread placement preserves the hermetic-default invariant: any leak of CLAUDE_CONFIG_DIR through `runtimeEnv` (e.g. via `createAgent({ env })`) is silently overridden by the driver's value.
- The PRD-anchored comment block (`claude.ts:189-199` in the pre-fix code) is replaced with one explaining the new ownership boundary: SAFE_HOST_VARS guards against host-env leakage; the driver-spread carries the curated sandbox env; driver-owned overrides enforce per-trial hermeticity.

### Module: SDK message projector (`src/agents/claude/sdk-message-projector.ts`)

- Unchanged. The projector's existing behavior — synthesize `use_skill` when given `firstMessage` starting with `/<name>` and `initSkills` containing `<name>` — is correct given correct inputs. The fix lives at the driver, which controls when those inputs are correct.
- The `SdkErrorSubtype` derivation (`NonNullable<AgentTurnResult['errorSubtype']>`) automatically widens when `src/types.ts` widens the underlying union; no projector code change is needed for the new subtype to type-check. The `SDK_ERROR_SUBTYPES` array stays as the SDK-reported subset because the projector's filter logic only matches subtypes Claude itself emits — `'bus_rejection'` is constructed by the driver and never flows through that array.

### Module: Ask-user bridge (`src/agents/claude/ask-user-bridge.ts`)

- The bridge's `lastError()` API is unchanged. The driver consumes its return value differently (constructs an error `AgentTurnResult` rather than throwing), but the bridge itself does not change.

### Module: Managed session (`src/sdk/managed-session.ts`)

- Unchanged. The `executeTurn` method (the path used by `AgentImpl`) does not perform an exit-code check; it returns the driver's `AgentTurnResult` verbatim. The exit-code check in the unrelated `send()` method serves a different caller surface and is outside the scope of this fix.

### Module: AgentImpl conversation flow (`src/sdk/agent.ts`)

- The `sendTurn` closure inside `runConversation` no longer throws on `turnResult.exitCode !== 0`. The closure continues to push `toolEvents` into the log (existing behavior, preserved verbatim) and returns the result regardless of exit code. The throw moves out of the closure.
- The `executeLoggedTurnResult` path used by `prompt()` and `startChat()` is **out of scope** for this fix. Those flows have a narrower observability surface (no `ask_batch` logging, no per-turn timing aggregation), and the loss on bus rejection there is bounded to the `model_agent_result` entry. Single-turn callers see the throw immediately and can inspect the error directly.

### Module: Conversation loop (`src/sdk/converse.ts`)

- After `pushModelAgentMessage` returns at the existing call site, `runConversation` checks `turnResult.exitCode` and throws on non-zero. The throw shape mirrors the message that previously lived in `AgentImpl.sendTurn` so downstream catch blocks (the existing `AskBusTimeoutError` branch, retry handling, etc.) keep working without modification.
- The five log surfaces inside `pushModelAgentMessage` (`model_agent_result`, `ask_batch`, turn timings, turn details, agent message push) now fire for bus-rejection turns because the driver returns rather than throws and `AgentImpl.sendTurn` no longer intercepts the result.

### Module: Type definitions (`src/types.ts`)

- The `AgentTurnResult.errorSubtype` union widens by one value: `'bus_rejection'`. The four existing values (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) are SDK-reported result subtypes; the new value is driver-synthesized. The naming distinction (no `error_` prefix) makes the layer of origin readable at the type site.

### Architectural decision: env composition ownership

The driver does not gatekeep which keys reach the SDK subprocess. Two layers above the driver own that:

- `prepareWorkspace` (`src/providers/workspace.ts`) merges safe host vars, sandbox-internal vars (HOME, TMPDIR), credential resolver output, and user-supplied `spec.env` into a single curated `Workspace.env`.
- The sandboxed-spawn module (`src/providers/sandboxed-claude-spawn.ts`) intersects the host env with `SAFE_HOST_VARS` to defend against accidental host-leak. This continues to apply to whatever the SDK subprocess inherits beyond `Options.env`.

The driver's job is to adapt the curated runtime env into the SDK's `Options.env`. Anything beyond that — including extending the credential resolver to handle non-auth env — belongs in those upstream layers, not in the driver.

### Architectural decision: slice numbering policy

Defect repairs to slices already landed on a feature branch are absorbed into the branch's eventual squash without numbered slice headers. Numbered slices remain reserved for planned PRD-bullet work. The fix commits on this branch follow this convention.

## Testing Decisions

A good test exercises external behavior at the smallest scope where the behavior actually lives. A test that needs to mock or arrange state across multiple modules to trigger one observable outcome is testing implementation details, not behavior. The failure modes here all live at specific scopes — runtime env composition lives at the driver, slash-command lifecycle lives at the driver, error contract lives at the driver — and the tests follow.

### Tests added

1. **F1 regression: runtime env reaches `Options.env` wholesale.**
   Driver test in `tests/claude-sdk-driver.test.ts`. Exercise the existing fake-`query` setup with a runtime handle whose `env` contains a non-auth key (e.g. `MY_USER_VAR`) and a sandbox-style `HOME`. Assert that the captured `Options.env` passed to the fake query contains both keys, plus the driver-owned `CLAUDE_CONFIG_DIR`. Prior art: the existing test at line 210 ("forwards ANTHROPIC_* keys from the runtime handle env onto Options.env") covers the auth-only subset; the new test broadens it to arbitrary keys.

2. **F1 regression: driver-owned `CLAUDE_CONFIG_DIR` wins on collision.**
   Same test file. Pass a `runtime.env` containing `CLAUDE_CONFIG_DIR: '/should/be/overridden'` and assert the captured `Options.env.CLAUDE_CONFIG_DIR` matches the per-workspace path, not the user-supplied value. Proves the hermetic invariant survives the wholesale spread.

3. **F3 regression: turn 2 with cached slash-command first message produces no synthesized event.**
   Driver test in `tests/claude-sdk-driver.test.ts` near the existing turn-2 resume test at line 154. Two-turn fake-query exercise: turn 1 message starts with `/skill-name`, turn 2 message is plain text, both turns' fake query emits an `init` system message containing `skill-name`. Assert turn 2's `AgentTurnResult.toolEvents` contains no event with `action === 'use_skill'` and `skillName === 'skill-name'`. Prior art: the existing projector test at `tests/claude-sdk-projector.test.ts:561` verifies single-turn synthesis behavior; the new test is its multi-turn complement at the driver scope.

4. **F2 cleanup: `ClaudeAgent.run()` falls through to base class diagnostic.**
   Driver test in `tests/claude-sdk-driver.test.ts`. Construct a `ClaudeAgent` and call `run()` directly. Assert the thrown error message is "Agent must implement createSession() or run()" — the base-class diagnostic — rather than the askBus-required message.

5. **Latent regression: bus rejection produces error `AgentTurnResult` with partial trace.**
   Driver test in `tests/claude-sdk-driver.test.ts`. Adapt the existing test at line 401 ("throws the ask-bus rejection out of runTurn") to the new error-return contract: instead of asserting the throw, assert that the returned `AgentTurnResult` has `exitCode === 1`, `errorSubtype === 'bus_rejection'`, `rawOutput` containing the bridge error message, and `toolEvents` reflecting any tool calls Claude made before the rejection.

6. **Latent regression: AgentImpl.sendTurn no longer throws on non-zero exit code; runConversation throws after pushModelAgentMessage.**
   Test in `tests/sdk/converse.test.ts` (or the matching test file for `runConversation`). Construct a fake `sendTurn` that returns an `AgentTurnResult` with `exitCode === 1`. Assert that `pushModelAgentMessage` ran (observable via the log having the `model_agent_result` and `ask_batch` entries for the failed turn) *and* that the final outcome is the throw with the expected message. This proves the log-then-throw ordering survives the refactor.

7. **Resume-after-rejection: turn 2 resumes from the rejected turn's session_id.**
   Driver test in `tests/claude-sdk-driver.test.ts`, multi-turn fake-query exercise. Turn 1's fake query emits an `init` system message with `session_id: 'rejected-turn-session-id'` and triggers a bus rejection (no result message). The driver returns an error `AgentTurnResult`. The test catches the eventual throw at the conversation-loop layer (or, when testing the driver's `AgentSession` directly, observes the error result), then issues turn 2 against the same session. Assert that turn 2's captured `Options.resume` equals `'rejected-turn-session-id'`. Prior art: existing turn-2 resume test at line 154 establishes the `Options.resume` capture pattern; this test is its error-path complement.

### Tests left unchanged

- The projector tests at `tests/claude-sdk-projector.test.ts:560-600+` (slash-command synthesis and absence cases) test correct projector behavior given correct inputs. Those inputs are unchanged at the projector boundary; the fix lives above it.
- The smoke tests at `tests/claude-sdk-smoke.test.ts:462-524` (init.skills and Skill tool name) cover real-SDK integration. Those continue to pass.

## Out of Scope

- **No change to the credential resolver.** The pluck-auth-only stance was wrong for the *driver*, but the credential resolver's auth-only contract is correct. Extending the resolver to handle arbitrary `createAgent({ env })` would make it a second env composer; that ownership belongs to `prepareWorkspace`, which already does it.
- **No change to `SAFE_HOST_VARS`.** The sandbox boundary against host env leakage is unchanged. HOME and TMPDIR remain *out* of `SAFE_HOST_VARS` (they reach the subprocess via `Options.env`-from-`runtime.env`, not via the host-filter path).
- **No change to the projector's slash-command synthesis logic.** The projector behavior is correct for its inputs; the fix is at the input-construction layer.
- **No change to the Codex (`TranscriptAgent`) or Cursor agents' `run()` methods.** Both have genuine single-turn code paths via private `runTurn` helpers and continue to expose `run()`. Only `ClaudeAgent`'s `run()` override is deleted.
- **No new SDK option, API, or capability.** This is a defect repair, not a feature.
- **No change to the squashed-PR-to-master workflow.** Fixes absorb into the existing branch's squash.
- **No follow-up PR after merge.** The fix lands in the same squash as the migration; master sees one consistent commit.
- **No change to the `prompt()` and `startChat()` flows in `AgentImpl`.** Their `executeLoggedTurnResult` path has its own exit-code check at a different call site. Single-turn callers see the throw with the same shape they did before; the partial-turn observability gap on those flows is bounded (no `ask_batch` aggregation lives there) and tracked separately if it surfaces.
- **No change to the `SDK_ERROR_SUBTYPES` array in the projector.** That array filters SDK-reported subtypes only; the new driver-synthesized `'bus_rejection'` value never flows through it.

## Further Notes

The four defects share a common shape: each one collapses information in a way that looks like a local micro-optimization but quietly drops a documented external contract. Auth-only env pluck collapses workspace env to a credential subset; cached `firstMessage` collapses per-turn lifecycle to a session constant; throw-on-bridge-rejection collapses partial turn observability to "nothing happened." The fixes consistently push back against the collapse: pass the workspace env through, gate by turn number, return a result instead of throwing.

The author of the migration documented their auth-only stance explicitly in a comment block. That comment is the right kind of artifact — it states the design intent so a reviewer can argue with it. The grilling session that produced this PRD relied on it: without the comment, "fix the env" would have been one possible reading among many; with the comment, the disagreement was sharply about the named ownership boundary. The replacement comment should preserve the same explicitness about the new pattern.

The bus-rejection error-return contract introduces a new `errorSubtype` value into the projector's typed enum (`SDK_ERROR_SUBTYPES`). The existing four (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) are SDK-reported result subtypes; the new one is driver-synthesized. The naming should make the distinction visible (e.g. `bus_rejection` rather than `error_*`) so a downstream consumer can tell which layer originated the error.

The merge-sequence policy ("fix-while-rebasing absorbs into squash") is documented as project memory but should also propagate into `TRACKER.md` if the project grows additional contributors. The current size doesn't warrant that yet.
