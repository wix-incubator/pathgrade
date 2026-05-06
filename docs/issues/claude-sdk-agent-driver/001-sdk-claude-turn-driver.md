## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Build the first end-to-end Claude SDK driver path behind the existing Claude agent entry point. A Claude session should run through `@anthropic-ai/claude-agent-sdk` using the same `BaseAgent.createSession` contract, preserve subprocess sandboxing through the SDK custom-spawn hook, load MCP config through SDK options, preserve resume-based multi-turn sessions, and expose the documented binary/auth/settings options from the PRD.

Implement as discrete modules per PRD §Module decomposition: this slice covers the **sandboxed-claude-spawn**, **MCP-config-loader**, and the orchestration shell of the **Claude-SDK-agent driver**. The **ask-user-bridge** module ships in #004 and the **SDK-message-projector** ships in #002; this slice may include placeholder seams for them but must not collapse the decomposition into the agent class.

Interim state: this slice is not master-mergeable on its own (see TRACKER §Merge model). Until #004 lands, the `canUseTool` callback installed here auto-allows non-`AskUserQuestion` tools and returns `{ behavior: "deny", message: "AskUserQuestion bridge not yet implemented (issue #004)" }` for `AskUserQuestion`. The deny is a placeholder so a stray pre-#004 turn fails loudly rather than hangs; #004 replaces it with the live bridge.

Type: AFK

## Acceptance criteria

- [ ] `ClaudeAgent.createSession()` uses the SDK query path instead of invoking the Claude CLI in print mode.
- [ ] The first turn starts a new SDK session and later turns resume with the prior SDK `session_id`.
- [ ] SDK options include the Claude Code system-prompt preset (`{ type: "preset", preset: "claude_code" }`), hermetic default `settingSources: ["project"]`, the typed option `autoMemoryEnabled: false` (the PRD-correct toggle — not an env var), `permissionMode: "default"`, and a custom spawn function.
- [ ] `Options.env` is populated with the union of `resolveCredentials()` / `resolveClaude()` auth pass-through and `CLAUDE_CONFIG_DIR` set to a per-trial scratch directory under the workspace (e.g. `<workspace>/.pathgrade-claude-config/`), so host `~/.claude.json`, user memory, and ambient state cannot leak in.
- [ ] The custom spawn path wraps Claude subprocesses in `sandbox-exec` (macOS; passthrough elsewhere) and constructs the subprocess env by intersecting the incoming `Options.env` with `SAFE_HOST_VARS` for ambient host vars and layering the SDK-provided values on top — no host-process env leaks through. Tests assert `ANTHROPIC_API_KEY` reaches the subprocess and a non-allowlisted host var (e.g. `HOME`) is not propagated except via `Options.env`.
- [ ] `AgentOptions.claudeCodeExecutable` and `PATHGRADE_CLAUDE_CODE_EXECUTABLE` can override the SDK bundled binary without reintroducing PATH shim avoidance.
- [ ] Existing MCP mock/config flows still work by reading pathgrade's generated MCP config into `Options.mcpServers` (object form, parsed inline from the file `writeMcpConfig` writes; the on-disk path is preserved for Cursor's separate consumer).
- [ ] `@anthropic-ai/claude-agent-sdk` is added to `package.json` `dependencies` pinned to a single major version (e.g. `^0.2.x`); the per-platform binary optional-dependency footprint is documented for the install section.
- [ ] Tests cover SDK option construction, executable override precedence, MCP config loading, env layering through the spawn module, and the placeholder `canUseTool` deny for `AskUserQuestion`, all without launching a real Claude process.

## Blocked by

None - can start immediately

## User stories addressed

- User story 9
- User story 10
- User story 11
- User story 12
- User story 13
- User story 14
- User story 15
- User story 16
- User story 20
- User story 21
- User story 23
- User story 26
- User story 34
- User story 38
- User story 39
- User story 40
