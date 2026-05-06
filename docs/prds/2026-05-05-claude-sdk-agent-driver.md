# PRD: Claude Agent SDK driver — real `AskUserQuestion` handshake

**Date:** 2026-05-05
**Tracks:** [Issue #38 — Non-interactive mode masks the ask-user handshake](https://github.com/wix-private/pathgrade/issues/38)

## Problem Statement

Pathgrade is an evaluation harness for agent skills. Many of those skills are built around an interactive convention: the agent uses a structured user-question tool to ask the user to pick between options, and then branches on the answer. For Creator Kit's `ask-user tool` convention this is the central contract — the question and the consumed answer are the unit of behavior an eval needs to verify.

Today, when the skill under test runs against Claude, pathgrade invokes Claude headlessly through the CLI in print mode with permissions skipped. Under that mode, Claude's built-in `AskUserQuestion` tool is permission-denied: the turn ends, the question gets reconstructed as plain assistant text, and the harness has no way to deliver the user's answer back to Claude as a real tool result. As a consequence:

- A fixture author can assert that Claude *attempted* to ask the question, but cannot assert that Claude *consumed* the answer and continued down the correct branch.
- The transcript shows a synthesized text message where the real tool call should be, which misleads scorers that key on tool-call structure (and which actively mislabels skills that follow the convention as if they were ignoring it).
- Pathgrade has had to build a "blocked-prompt queue" workaround that feeds reaction answers back into a subsequent turn as a user reply — a multi-turn approximation of an in-turn handshake.
- Pathgrade's Claude integration is built on scraping NDJSON from a CLI not designed to be driven this way, which makes every new feature expensive (regex on stream output, per-flag parsing, brittle session-id handling).

The user impact is that interactive convention flows can only be partially verified. The tooling impact is that pathgrade carries a layer of synthesis machinery that exists solely to compensate for a missing channel.

## Solution

Replace the Claude integration's CLI-scraping driver with one built on `@anthropic-ai/claude-agent-sdk`. The SDK fires a `canUseTool` callback whenever Claude invokes `AskUserQuestion`. Pathgrade resolves the question through its existing ask-bus and reaction infrastructure and returns the chosen answer as the tool's real result. Claude receives the answer mid-turn and proceeds along the correct branch. The transcript records the literal `AskUserQuestion` tool name with its real input and the actual answer. Reactions can now express, verify, and assert the entire handshake — invocation, options, answer, branch — in a single round-trip rather than a multi-turn approximation.

The SDK is a typed-protocol wrapper around a bundled per-platform `claude` binary. Pathgrade keeps its subprocess-based sandbox model: the SDK's custom-spawn hook lets pathgrade wrap each Claude subprocess with `sandbox-exec` exactly as today. The bundled binary becomes the default for reproducible eval runs; users can override it for cases where they need to grade a specific local install. Auth, skills auto-discovery, MCP, and session resume all continue to work the way users already expect, because the SDK delegates them to the same CLI binary.

The synthesis machinery that the old driver depended on — blocked-prompt queues, denial reconstruction, the runtime-policy text injection that worked around the missing channel — is removed in the same change, because its reason for existing is gone.

## User Stories

1. As a fixture author, I want to assert that Claude invoked `AskUserQuestion` with a specific list of options, so that I can detect skills that fail to ask the documented choice.
2. As a fixture author, I want to declare an ask-user reaction that supplies a chosen answer and have Claude continue down the corresponding branch, so that I can test branch-conditional skill behavior end to end.
3. As a fixture author, I want the transcript to record the literal tool name `AskUserQuestion` (not synthesized prose), so that scorers that key on tool structure work without special-casing.
4. As a scorer author, I want each ask_user tool event to carry both the questions offered and the answer values supplied (with their source — reaction, fallback, or declined), so that I can score "agent asked the right question AND consumed the answer" without parsing prose.
5. As a fixture author, I want my fixture's `whenAsked` reactions to fire in real time during a Claude turn, not retroactively as post-hoc projections, so that reactions express in-flight intent and can drive branch choice.
6. As a fixture author with multi-question batches, I want each question's answer matched independently by my reactions' `whenAsked` predicates, so that I can supply different answers for different questions in the same call.
7. As a fixture author whose skill asks freeform questions, I want my reaction to supply free-text answers, so that I can simulate users who type custom responses outside the predefined options.
8. As a fixture author, I want a missing reaction to surface as a structured "unmatched ask_user" failure with the question text and turn number, so that I can diagnose which question went unhandled.
9. As an eval-running engineer in CI, I want pathgrade to use a pinned, bundled Claude binary by default, so that today's green eval is still green tomorrow even when my locally installed Claude CLI updates.
10. As an eval-running engineer in CI, I want to override the bundled binary via an environment variable or option, so that I can test against a specific in-development Claude build.
11. As a pathgrade user with an existing Claude subscription, I want my `claude login` keychain credentials to continue working with pathgrade, so that I don't have to provision new auth for the migration.
12. As a pathgrade user in CI without keychain access, I want to provide auth via `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, so that automated eval runs work without an interactive login.
13. As a pathgrade user using Bedrock, Vertex, or Foundry, I want pathgrade to inherit those credentials from the standard environment variables, so that enterprise auth setups continue working unchanged.
14. As a fixture author who stages skills into the workspace, I want skills under `<workspace>/.claude/skills/<name>/SKILL.md` to be auto-discovered by Claude during the run, so that fixtures can scope skill availability per trial.
15. As a fixture author who relies on user-level skills, I want those still available when a fixture doesn't override them, so that ambient eval setup is unchanged.
16. As a pathgrade maintainer, I want each Claude turn to expose typed message events at session init, per assistant message, and at result, so that I can build new observability features without writing more NDJSON parsers.
17. As a pathgrade maintainer, I want each Claude turn to report cache-creation and cache-read input tokens alongside input and output tokens, so that pathgrade's existing token-usage telemetry remains accurate.
18. As an eval consumer, I want to see total cost in USD per turn and per run, so that I can budget for batch eval runs against expensive models.
19. As an eval consumer, I want to see error subtypes (max-turns exceeded, max-budget exceeded, mid-execution failure) distinguished from "successful turn", so that I can triage failures correctly without regex on the result text.
20. As a pathgrade maintainer, I want the Claude subprocess to run inside `sandbox-exec` exactly as today, so that filesystem isolation and trial reproducibility are preserved across the migration.
21. As a fixture author, I want my fixture's MCP servers (mock or real) to continue working without changes, so that I don't have to migrate fixtures along with the agent driver.
22. As a fixture author using slash commands, I want pathgrade to detect slash-command-invoked skills and emit a `use_skill` tool event the same way as today, so that scorers that key on `use_skill` continue working.
23. As a fixture author whose flow spans multiple turns, I want session state preserved across turns through the SDK's resume mechanism, so that long-running multi-turn fixtures keep working.
24. As a fixture author whose fixture relies on the runtime-policy text being prepended for non-interactive agents, I want the policy still applied for Codex (exec mode) and Cursor; for Claude the policy goes away because the SDK driver makes it unnecessary.
25. As a pathgrade maintainer, I want the deprecated `blockedPrompts` field, the pending-blocked-prompt queue, the runtime-policy injection for Claude, and all denial-synthesis helpers removed in this change, so that the codebase reflects a single coherent model rather than a deprecated path orbiting alongside its replacement.
26. As a pathgrade maintainer, I want the new driver to retain the existing `BaseAgent.createSession` interface, so that all upstream consumers (managed sessions, conversation runner, fixture loaders) work without changes.
27. As a pathgrade maintainer, I want each tool event emitted during a Claude turn to carry tool input as structured data, so that tool-event enrichment (skill detection, slash-command detection) keeps working unchanged.
28. As a fixture author, I want `whenAsked` predicates to evaluate against the same structured `AskUserQuestion` shape they evaluate against today (questions, options, multiSelect), so that complex predicates stay intact.
29. As a fixture author whose reaction declines an ask-user question, I want Claude to receive a "declined" signal that's faithful to a real headless host (per the SDK's documented contract), so that the branch behavior matches what would happen with a real user pressing escape.
30. As a pathgrade maintainer, I want Claude's interactive-question transport capability flipped from "noninteractive" to "reliable", so that the conversation-time preflight treats Claude the same as Codex app-server (no fail-fast on ask-user reactions).
31. As a pathgrade maintainer, I want the test suite for the new driver to include unit tests for each of the deep modules plus one end-to-end integration test that runs a Claude turn against a mocked SDK and asserts a full ask-user round-trip, so that regressions are caught at the most localized level possible.
32. As a pathgrade maintainer, I want the migration to land in a single change (no transport flag, no opt-in period), so that the repo never lives in a half-state where the deprecated synthesis path coexists with its replacement.
33. As an eval consumer who reads run snapshots, I want the snapshot's ask_user projection (the `ToolEvent` arguments shape) to remain stable across the migration, so that historical run-snapshot comparisons still parse.
34. As a pathgrade maintainer, I want the SDK dependency added to the package manifest with a pinned-to-major version range, so that minor SDK updates don't surprise CI.
35. As a fixture author whose skill spawns subagents through the `Task` tool, I want pathgrade documentation to call out that ask-user is not available inside subagents (per the SDK docs), so that I don't write fixtures that depend on a subagent ask-user flow that can't fire.
36. As a fixture author migrating from the old driver, I want my existing reaction-based and conversation-level tests to keep passing without changes, so that the migration is invisible at the fixture API layer.
37. As a pathgrade maintainer, I want a one-time verification spike during implementation that confirms `permissionMode: "default"` plus auto-allowing `canUseTool` actually causes `AskUserQuestion` to reach the callback, so that we don't ship a driver that silently regresses to no-handshake under unexpected SDK behavior.
38. As a pathgrade maintainer, I want the resolved `claude` executable strategy to drop the existing PATH-search shim-avoidance helper, so that one less piece of pre-SDK infrastructure remains in the codebase.

## Implementation Decisions

### Architecture

- The Claude driver is replaced in place. The migration lands in a single change with no transport flag, no opt-in period, and no parallel CLI driver retained.
- The new driver implements the same `BaseAgent.createSession` contract as today. All upstream consumers (managed-session wrapper, conversation runner, fixture loaders, scorers, snapshot projectors) are unchanged.
- The driver is composed of four deep modules with focused interfaces, plus a small MCP-config helper. The driver class itself is orchestration over those modules.

### Module decomposition

- **Sandboxed-claude-spawn module** — a pure function that adapts the SDK's spawn options into pathgrade's sandbox model. Given a working directory, argv, environment, and executable path, returns a spawned process whose argv has been wrapped with `sandbox-exec` on macOS (or passed through unchanged on other platforms) using pathgrade's existing sandbox profile and env-filtering policy. Knows nothing about Claude, the SDK, or evals.
- **Ask-user-bridge module** — the `canUseTool` callback expressed as a pure function. Given an ask-bus reference, a turn number, a tool name, and a tool input, returns a `CanUseToolResult`. For `AskUserQuestion`: builds an `AskBatch` from the input's `questions` (live lifecycle, source `claude`, sourceTool `AskUserQuestion`), emits to the bus, awaits resolution, translates the resolved `AskAnswer` array into the SDK's documented answers shape (a record keyed by question text whose values are the chosen labels, with multi-select joined by comma-space, free-text used directly), and returns an allow decision with the populated `updatedInput`. For all other tool names: returns an allow decision with the original input passed through.
- **SDK-message-projector module** — replaces the existing stream-json parser and tool-event extractor. Consumes the SDK's typed message stream, accumulates assistant text, tool-use blocks, init metadata (skills, slash commands, tools, MCP servers, model, version), per-turn usage including cache tokens, and typed errors. Produces an `AgentTurnResult`.
- **MCP-config-loader helper** — reads pathgrade's existing MCP config JSON file and returns the SDK's `mcpServers` options object. Lives next to the existing `writeMcpConfig` provider; the file-write step is unchanged.
- **Claude-SDK-agent driver** — orchestrates the above. Owns per-session state (session id, turn counter, ask-bus reference). Per turn, configures the SDK options (cwd, model, mcp servers, custom spawn function, custom can-use-tool, resume id when present), runs `query()`, drains the typed message stream through the projector, and returns the resulting `AgentTurnResult`.

### SDK option choices

- `permissionMode` is `"default"`. The driver always installs a `canUseTool` that auto-allows non-`AskUserQuestion` tools and routes `AskUserQuestion` through the ask-bus. This contract is strictly safer than `bypassPermissions` because it preserves the `canUseTool` callback for every tool decision and removes ambiguity about whether the callback fires for clarifying-question cases under bypass mode.
- `cwd` is set to the workspace path so skills under `<workspace>/.claude/skills/` are auto-discovered.
- `settingSources` is left at the default (`["user", "project"]`), preserving auto-discovery of user-level skills under `~/.claude/skills/`.
- `allowedTools` is not set, leaving the full Claude tool surface available, including `AskUserQuestion`.
- `model` is forwarded from the existing session option.
- `mcpServers` is built from pathgrade's existing MCP config JSON, parsed into the SDK options shape inline. Existing stdio-based mock servers continue working unchanged.
- `pathToClaudeCodeExecutable` is omitted by default (uses the SDK's bundled per-platform binary), and is set when the user supplies an override via a new conversation option or environment variable.
- `spawnClaudeCodeProcess` is set to the sandboxed-claude-spawn module so every Claude subprocess runs under pathgrade's sandbox profile.
- `resume` is set on every turn after the first, using the session id reported on the previous turn's result message.

### Capabilities and runtime policies

- `claude.interactiveQuestionTransport` is flipped from `"noninteractive"` to `"reliable"` in the agent capabilities table.
- The non-interactive runtime policy is removed from Claude's plan. The policy infrastructure remains in place for Codex (exec) and Cursor, which are still subject to the synthesis problem this PRD does not address.
- The runtime-policies-applied field on the turn result is preserved as an empty array for Claude.

### Deletions

- The deprecated `BlockedInteractivePrompt` type and the deprecated `blockedPrompts` field on `AgentTurnResult` are removed.
- The `'blocked_prompt'` value of `VisibleAssistantMessageSource` is removed.
- The pending-blocked-prompt queue and its dispatch branch in the conversation runner are removed.
- The denial-reconstruction helpers, the formatted-blocked-prompt helper, and the visible-message blocked-prompt branch are removed.
- The Claude permission-denial → ask-batch parser helper is removed.
- The PATH-search executable resolver with shim avoidance is removed; the SDK's bundled binary handles binary resolution.
- Any test files dedicated to blocked-prompt-queue behavior are removed.

### Authentication

- Authentication is delegated to the bundled Claude subprocess. No pathgrade-side auth handling is added or changed.
- Documented sources of auth that work end-to-end: subscription via keychain, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` plus `CLAUDE_CODE_OAUTH_SCOPES`, Bedrock (`AWS_BEARER_TOKEN_BEDROCK` and the bypass switches), Vertex, and Foundry. Pathgrade's existing sandbox env-pass-through ensures these reach the subprocess.

### Multi-turn semantics

- Each turn is one `query()` call. The first turn omits `resume`. Subsequent turns pass the prior turn's `session_id` as `resume`.
- Session-id sanitization is removed because the value is no longer interpolated into a shell command.
- The conversation runner's existing turn-counter and reactions-fired tracking is unchanged.

### Tool event extraction

- The existing tool-name mapping, the skill-event enrichment, and the slash-command detection (first message starts with `/<name>` and `<name>` is in the init message's skills array) are preserved. The inputs they consume are the same structured tool-use blocks they consume today, sourced from the SDK's typed `assistant` messages instead of NDJSON.

### Migration boundary

- The migration is one change. The repo never lives in a half-state with both drivers present.
- The SDK is added to the package manifest as a runtime dependency pinned to a major version. The bundled-binary optional dependency that ships per platform follows the SDK's own dependency graph.
- The user guide is updated to call out that `AskUserQuestion` is unavailable inside subagents (per the SDK's documented limitation) and to explain the new `pathToClaudeCodeExecutable` override pathway.

## Testing Decisions

A good test exercises external behavior — the contract a consumer of the module relies on — and remains stable across implementation refactors. Tests should not assert internal helper-function shapes or mock-call sequences when the same contract can be expressed against the module's public input-output behavior. Each deep module has a focused interface that lends itself to that style.

### Modules covered by tests

- **Sandboxed-claude-spawn module.** Tests feed fake spawn options (cwd, argv, env, executable), then assert that the resulting spawned process was launched with the expected argv prefix and a filtered env dictionary. Tests inject a fake spawn delegate so no real subprocess runs. Platform-specific behavior is exercised by stubbing the platform check. Prior art: the codex transport's spawn-and-handshake unit tests for shape, and any existing tests around the sandbox provider for env-filter assertions.
- **Ask-user-bridge module.** Tests feed canned tool-name and input pairs against a mock ask-bus that returns canned `AskAnswer` results, and assert that `CanUseToolResult.updatedInput.answers` matches the SDK's documented shape across single-select, multi-select, and free-text variants. A separate set of tests exercises non-`AskUserQuestion` tool names, asserting pass-through with original input. Prior art: the existing ask-bus handler tests that exercise reaction matching and unmatched-fallback behavior.
- **SDK-message-projector module.** Tests feed canned typed-message sequences (a successful turn, each error subtype, an init message with skills and slash commands, a multi-tool-use assistant turn, hook-lifecycle events, rate-limit events) and assert the resulting turn-result shape including assistant message text, tool events, runtime-policies-applied, input/output/cache tokens, error flags, and visible assistant message. Prior art: the existing tool-events tests for canonical-action mapping, and the existing converse projector tests that turn message sequences into typed outputs.
- **MCP-config-loader helper.** Tests read sample MCP config files (one mock-server variant, one passthrough config-file variant) and assert the resulting `mcpServers` options object shape. Prior art: any existing fixture-loading tests in the providers layer.

### Integration test

- One end-to-end test drives the new Claude SDK agent driver against a mocked SDK harness across two turns. Turn 1 emits an `AskUserQuestion` tool call; the test installs a reaction whose answer maps to a specific option label. Turn 2 emits an assistant message that branches based on the chosen answer. The test asserts the full ask_user tool event shape (questions, options, the supplied answer values, the answer source field set to `'reaction'`), the bus snapshot's resolved batch, the visible assistant message on each turn, and the per-turn token usage. Prior art: the existing codex app-server agent tests, and the existing converse-ask-user tests.

### Tests that remain unchanged

- The conversation runner's ask-user tests — they exercise the contract this migration preserves and should continue passing without modification.
- The reaction loader and bus handler tests — same rationale.
- The tool-events tests for canonical-action mapping and skill enrichment — input shape is unchanged.

### Verification spike

- A one-time integration check (5-line script committed under the test tree) confirms that `permissionMode: "default"` plus an auto-allowing `canUseTool` does in fact route `AskUserQuestion` through the callback against a real SDK. The check is a smoke test for the SDK-level contract that the design depends on; once the integration test exercises the same contract transitively, the spike script can be removed.

## Out of Scope

- Fixture-facing permission knobs (`permissionMode`, `allowedTools`, `disallowedTools`, custom `canUseTool`). Fixtures continue to see today's behavior: every tool runs, ask-user reactions resolve through the bus.
- Migrating stdio-based MCP mock servers to in-process SDK MCP servers. The existing forking model is preserved.
- Codex (exec mode) migration to an equivalent SDK-driven path. Codex (app-server) already has a real handshake; Codex (exec) remains subject to the existing fail-fast preflight.
- Cursor migration. Cursor is still in the `noninteractive` capability tier and continues to use today's mechanisms.
- Visual previews on ask-user options (`toolConfig.askUserQuestion.previewFormat`). Future enhancement.
- The `defer` hook decision for evals that exceed a single host process lifetime. Future enhancement for batch runners.
- The mid-session permission-mode change API. Not needed for current eval flows.
- Streaming-input multi-turn pattern (a single long-lived `query()` with a user-message async iterable). The resume-per-turn model is simpler and matches the existing per-turn lifecycle.
- Subagent (`Task` tool) ask-user support. Not exposed by the SDK by design; documented as a limitation.
- Adopting the broader observability stream the SDK exposes (hook lifecycle, task lifecycle, partial assistant messages, files-persisted events, rate-limit events, prompt-suggestion messages). Worth its own follow-up PRD.
- A fixture-facing API to set `pathToClaudeCodeExecutable` per-trial. The CLI override is exposed via a single conversation option and an environment variable; per-trial overrides are deferred until a use case appears.

## Further Notes

- This PRD tracks Issue #38 ("Non-interactive mode masks the ask-user handshake — can't verify answer consumption"). The migration directly closes the gap the issue describes.
- The migration is a strict superset of current capabilities. Every CLI behavior pathgrade depends on (auth, skills auto-discovery, MCP config, sandbox isolation, session resume, slash-command detection, skill-event enrichment) is preserved. Several capabilities are upgraded for free: typed error subtypes, total-cost reporting, per-turn cache-token detail, hook lifecycle events, task lifecycle events.
- The SDK ships per-platform `claude` binaries as optional npm dependencies. Install size will increase by tens of megabytes; this should be called out in the install section of the user guide. Users who already have the CLI installed and want to avoid the duplicate footprint can skip the optional dependency at install time and set the override path.
- Worth filing alongside this PRD: an upstream feature request to Anthropic for explicit documentation of the `permissionMode: "default"` × `canUseTool` × `AskUserQuestion` interaction, so the verification spike under "Testing Decisions" can be retired once the docs are updated.
- The same architectural pattern (SDK-driven driver, custom spawn, `canUseTool` for ask-user routing) is the obvious next step for Cursor once that integration is ready to migrate. This PRD does not pre-commit to the Cursor path but leaves the door open.
