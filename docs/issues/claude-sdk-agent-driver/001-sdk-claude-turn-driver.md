## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Build the first end-to-end Claude SDK driver path behind the existing Claude agent entry point. A Claude session should run through `@anthropic-ai/claude-agent-sdk` using the same `BaseAgent.createSession` contract, preserve subprocess sandboxing through the SDK custom-spawn hook, load MCP config through SDK options, preserve resume-based multi-turn sessions, and expose the documented binary/auth/settings options from the PRD.

Type: AFK

## Acceptance criteria

- [ ] `ClaudeAgent.createSession()` uses the SDK query path instead of invoking the Claude CLI in print mode.
- [ ] The first turn starts a new SDK session and later turns resume with the prior SDK `session_id`.
- [ ] SDK options include the Claude Code system-prompt preset, hermetic default `settingSources`, disabled auto-memory, `permissionMode: "default"`, and a custom spawn function.
- [ ] The custom spawn path wraps Claude subprocesses in the existing sandbox model and preserves existing environment filtering.
- [ ] `AgentOptions.claudeCodeExecutable` and `PATHGRADE_CLAUDE_CODE_EXECUTABLE` can override the SDK bundled binary without reintroducing PATH shim avoidance.
- [ ] Existing MCP mock/config flows still work by reading pathgrade's generated MCP config into `Options.mcpServers`.
- [ ] Tests cover SDK option construction, executable override precedence, MCP config loading, and sandboxed custom spawn behavior without launching a real Claude process.

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
