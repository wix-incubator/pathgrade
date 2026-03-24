# Pathgrade MCP-S Remote LLM Backend Spec

**Date:** 2026-03-23
**Status:** Draft
**Related:** [docs/2026-03-23-mcp-s-remote-llm-prd.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-mcp-s-remote-llm-prd.md), [docs/ARCHITECTURE.md](/Users/nadavlac/projects/pathgrade/docs/ARCHITECTURE.md)

## 1. Overview

This spec defines a Phase 1 hybrid design for removing model-provider API keys from employee machines while preserving the current local Pathgrade runtime.

The design keeps:

- local trial workspaces
- local agent CLI execution
- local conversation orchestration

The design changes:

- rubric-based grading
- persona reply generation

Both LLM-backed features will be routed through a Pathgrade-owned MCP tool surface and invoked deterministically via `mcp-s-cli`.

## 2. Scope

### In scope

- deterministic `mcp-s-cli` invocation from Pathgrade
- remote backend for `llm_rubric` graders
- remote backend for persona reply generation
- runtime backend selection for employee machines versus CI
- installation, auth preflight, and error handling for the CLI-backed path

### Out of scope

- remote agent execution
- remote workspace ownership
- moving deterministic shell graders remote
- redesigning `eval.yaml` for task authors

## 3. Current State

### Current LLM path

Pathgrade currently makes direct provider calls from the local process:

- [src/utils/llm.ts](/Users/nadavlac/projects/pathgrade/src/utils/llm.ts) selects Gemini, Anthropic, or OpenAI based on API keys and optional model override.
- [src/graders/index.ts](/Users/nadavlac/projects/pathgrade/src/graders/index.ts) builds the rubric-evaluation prompt and calls `callLLM(...)`.
- [src/persona.ts](/Users/nadavlac/projects/pathgrade/src/persona.ts) builds the persona prompt and calls `callLLM(...)`.

### Current agent path

The agent loop is local and depends on local workspace execution:

- agent adapters in `src/agents/*.ts`
- local runtime isolation in `src/providers/local.ts`
- orchestration in [src/evalRunner.ts](/Users/nadavlac/projects/pathgrade/src/evalRunner.ts) and [src/conversationRunner.ts](/Users/nadavlac/projects/pathgrade/src/conversationRunner.ts)

This means the agent loop should not be part of Phase 1.

## 4. Architecture Decision

### Chosen approach

Use a hybrid runtime:

- local Pathgrade process remains the orchestrator
- a new MCP-S backend is added only for LLM-backed features
- Pathgrade calls remote tools deterministically using `mcp-s-cli call`

### Why this approach

1. It solves the immediate security blocker with the smallest possible runtime change.
2. It fits the seams that already exist in the codebase.
3. It avoids turning Phase 1 into a redesign of trial execution, filesystem isolation, and command streaming.

### Rejected alternatives

#### Full remote agent loop now

Rejected for Phase 1 because the current agent flow is tightly coupled to a local isolated workspace and command runner.

#### Custom serverless service before MCP-S

Rejected as the first move because `mcp-s-cli` already gives us deterministic invocation, auth integration, and a standard gateway path.

## 5. Proposed Design

### 5.1 Components

Phase 1 introduces four components:

1. **Pathgrade host runtime**
   - continues to build prompts, assemble transcripts, and orchestrate trials
2. **`McpSClient` wrapper inside Pathgrade**
   - shells out to `mcp-s-cli`
   - performs auth preflight and parses tool responses
3. **Pathgrade MCP server**
   - deployed inside Wix infra
   - owns provider secrets server-side
4. **MCP-S gateway**
   - authenticates employee traffic through Wix auth
   - routes tool calls to the Pathgrade MCP server

### 5.2 Tool Surface

Phase 1 uses two Pathgrade-specific remote tools:

- `grade_with_llm`
- `generate_persona_reply`

These are intentionally deterministic tool calls, not agent-selected tool use.

### 5.3 Prompt Ownership

Prompt construction stays in Pathgrade for Phase 1.

That means:

- [src/graders/index.ts](/Users/nadavlac/projects/pathgrade/src/graders/index.ts) still assembles the rubric prompt locally
- [src/persona.ts](/Users/nadavlac/projects/pathgrade/src/persona.ts) still assembles the persona prompt locally
- the remote tools act as secure execution backends for those prompts

This choice minimizes migration risk and preserves behavior parity with the current local implementation.

### 5.4 Data Transmission and Compliance

Remote prompt payloads may contain:

- task instructions
- conversation transcripts
- rubric text
- command stdout and stderr captured in session logs
- prior grader results
- generated code snippets that appear in the transcript or command output

That means Phase 1 is not only a secret-management change. It is also a data-transmission change.

Requirements:

- document the payload categories explicitly before rollout
- obtain security/compliance sign-off before production enablement
- define what content must be redacted locally before transmission or persistence
- avoid logging raw MCP-S stderr when it may contain tokens, URLs, or other sensitive diagnostics

## 6. Backend Selection

### 6.1 Runtime control

Add a new process-level backend selector:

```text
PATHGRADE_LLM_BACKEND=auto|local|mcp_s
```

Default: `local`

### 6.2 Resolution rules

`local`
- use the existing direct-provider logic in `src/utils/llm.ts`

`mcp_s`
- require `mcp-s-cli`
- require a supported CLI version
- require working auth
- route all supported LLM-backed calls through MCP-S
- act as the strict no-fallback mode
- fail immediately if any prerequisite is missing

`auto`
- prefer `mcp_s` if:
  - `mcp-s-cli` is available
  - the CLI version is supported
  - auth preflight succeeds
- otherwise fall back to `local` if provider API keys are available
- emit a visible warning when fallback happens
- record the backend resolution and fallback reason in the session log
- otherwise fail with an actionable error

`auto` is an opt-in convenience mode in Phase 1. It is not the rollout default.

For repeatable evaluation, prefer explicit `local` or explicit `mcp_s` plus an explicit model. `auto` is for gradual adoption, not for baseline comparability.

### 6.3 Additional environment variables

```text
PATHGRADE_MCP_S_CLI=mcp-s-cli
PATHGRADE_MCP_S_CONFIG_PATH=/optional/path/to/config.json
PATHGRADE_MCP_S_GRADE_TOOL=grade_with_llm
PATHGRADE_MCP_S_PERSONA_TOOL=generate_persona_reply
PATHGRADE_MCP_S_TIMEOUT_MS=90000
PATHGRADE_MCP_S_MIN_VERSION=0.0.21
```

These stay outside `eval.yaml` because they describe runtime infrastructure, not evaluation content.

These variables are host-process configuration only.

They must not be sourced from:

- task `.env` files
- eval workspace files
- per-trial runtime env maps passed to agent execution

Employee onboarding or wrapper commands must set them in the host shell environment when secure mode is required.

### 6.4 Backend Pinning Per Trial

Backend resolution happens once per trial on the first LLM-backed call and stays fixed for the rest of that trial.

This requires an explicit trial-scoped LLM execution context rather than a hidden process-global cache.

Rules:

- `local` trials stay local for every subsequent LLM-backed call
- `mcp_s` trials stay remote for every subsequent LLM-backed call
- `auto` resolves once, records the selected backend, and then behaves the same way
- if an `mcp_s` trial later hits MCP-S auth or infrastructure errors, Pathgrade does not degrade that same trial to `local`
- later failures must surface as explicit infrastructure failures in logs rather than silently changing backend mid-trial

This avoids internally inconsistent trials where rubric grading and persona replies come from different backends.

## 7. Code-Level Design

### 7.1 `src/utils/llm.ts`

Refactor `callLLM(...)` into a backend-aware entry point.

Add a trial-scoped context type:

```ts
export interface LLMExecutionContext {
    trialId: string;
    resolvedBackend?: 'local' | 'mcp_s';
    resolutionReason?: string;
}
```

Initial client-owned remote defaults:

```ts
const DEFAULT_REMOTE_GRADE_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_REMOTE_PERSONA_MODEL = 'gemini-3-flash-preview';
```

Proposed interface:

```ts
export interface LLMCallOptions {
    model?: string;
    env?: Record<string, string>;
    temperature?: number;
    purpose?: 'generic' | 'llm_rubric' | 'persona_reply';
    context?: LLMExecutionContext;
}
```

Behavior:

- resolve backend before any provider inference or local API-key inspection
- `local` backend supports all current behavior
- `mcp_s` backend supports:
  - `purpose: 'llm_rubric'`
  - `purpose: 'persona_reply'`
- `purpose: undefined` is treated as `generic`
- `purpose: 'generic'` remains local-only in Phase 1 and must throw a clear error if forced through `mcp_s`
- `purpose: 'llm_rubric'` and `purpose: 'persona_reply'` must receive a trial-scoped `context`
- backend resolution is stored on `context.resolvedBackend` and reused for later calls in the same trial
- when the selected backend is `mcp_s`, `callLLM(...)` must short-circuit directly to `McpSClient` without calling `inferProviderFromModel(...)`, `getProviderSequence(...)`, or local key checks
- remote calls must always send an explicit model
- if the caller does not provide a model, Pathgrade must fill one from a purpose-specific client-owned default before invoking `McpSClient`
- local provider fallback order remains Gemini -> Anthropic -> OpenAI
- MCP-S does not promise the same provider fallback behavior unless an explicit model is requested

This keeps the remote surface intentionally narrow.

The spec keeps a single `callLLM(...)` entry point with `purpose` rather than adding a separate remote-only public function. The shared entry point keeps backend routing centralized and auditable while still requiring explicit purpose annotation for remote-capable calls.

`EvalRunner` must create one `LLMExecutionContext` per trial and pass it through every grader and conversation-side LLM call for that trial. `ConversationRunner` reuses the same context for all persona generations within that trial.

### 7.2 `src/graders/index.ts`

Keep rubric prompt assembly local.

Change the `callLLM(...)` invocation to:

```ts
callLLM(prompt, {
    model: config.model,
    env,
    purpose: 'llm_rubric',
    context,
});
```

No change to the grader contract or JSON parsing behavior is required.

If `config.model` is unset, the client must substitute `DEFAULT_REMOTE_GRADE_MODEL` before calling MCP-S instead of relying on a server-side implicit default.

### 7.3 `src/persona.ts`

Keep persona prompt assembly local.

Change the `callLLM(...)` invocation to:

```ts
callLLM(prompt, {
    model: persona.model || model,
    env,
    purpose: 'persona_reply',
    context,
});
```

`persona.model` must take precedence when it is configured. Any task-level or grader-level fallback model is used only when `persona.model` is unset.

This requires the conversation path to stop treating the grader model as a stronger override than the persona model.

If both are unset, the client must substitute `DEFAULT_REMOTE_PERSONA_MODEL` before calling MCP-S instead of relying on a server-side implicit default.

### 7.4 New helper: `src/utils/mcpS.ts`

Add a new utility responsible for:

- locating the CLI using:
  - `PATHGRADE_MCP_S_CLI` if set
  - otherwise a package-local installed binary resolved from Pathgrade's own module location
  - otherwise `PATH` lookup for `mcp-s-cli`
  - otherwise fail
- validating the CLI version against the minimum supported version
- running `mcp-s-cli check-auth`
- invoking `mcp-s-cli call <tool>` via `child_process.spawn` with `shell: false`
- sending request JSON over stdin only
- building the child env from host `process.env` plus an allowlist of `PATHGRADE_MCP_S_*` overrides
- never forwarding the trial env, `getRuntimeEnv(runtime)`, or arbitrary `opts.env` values into the CLI subprocess
- parsing stdout as JSON
- extracting the top-level MCP tool envelope into an `LLMCallResult`-compatible object
- mapping exit codes to actionable errors
- enforcing a per-call timeout
- sanitizing stderr before it reaches logs or callers
- caching successful preflight checks with a bounded TTL
- deduplicating concurrent preflight work through a shared in-flight promise

Do not use `npx`, `exec`, or shell-interpolated command strings for CLI invocation.

The package-local CLI lookup must not depend on the current working directory.

Concrete response mapping:

```ts
type RemoteToolResponse = {
    text: string;
    requestedModel?: string;
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
};
```

`McpSClient` must:

- parse CLI stdout into `RemoteToolResponse`
- validate that `provider` is one of `gemini`, `anthropic`, or `openai`
- reject unknown provider strings with a typed error
- return:

```ts
{
  text: response.text,
  provider: response.provider,
  model: response.model,
  inputTokens: response.inputTokens,
  outputTokens: response.outputTokens,
}
```

### 7.5 Preflight Cache Behavior

Auth preflight caching must be:

- TTL-bounded, default 5 minutes
- invalidated immediately on any CLI exit code `4`
- shared across concurrent callers so parallel trials do not all spawn `check-auth`
- implemented as a single shared in-flight promise for concurrent callers

This keeps `auto` mode predictable during long-running evals and parallel trial runs.

Auth errors should be classified as precisely as the CLI allows:

- "not logged in" when auth state is missing
- "session expired" when cached auth is present but no longer valid
- generic auth failure only when stderr does not allow a better distinction

## 8. MCP Tool Contracts

### 8.1 `grade_with_llm`

Input:

```json
{
  "prompt": "full rubric evaluation prompt",
  "model": "optional model override",
  "temperature": 0,
  "metadata": {
    "source": "pathgrade_llm_rubric",
    "contractVersion": 1
  }
}
```

Output:

```json
{
  "text": "{\"score\":0.8,\"reasoning\":\"...\"}",
  "requestedModel": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 1234,
  "outputTokens": 210
}
```

If `model` is provided, the server must either:

- honor the exact requested model, or
- fail clearly with a structured unsupported-model error

It must not silently substitute a different model.

If `model` is omitted by mistake, the client is still responsible for filling an explicit default before the request is sent.

If `temperature` is provided, the server must honor that exact value or reject the request clearly.

### 8.2 `generate_persona_reply`

Input:

```json
{
  "prompt": "full persona reply prompt",
  "model": "optional model override",
  "temperature": 0,
  "metadata": {
    "source": "pathgrade_persona_reply",
    "contractVersion": 1
  }
}
```

Output:

```json
{
  "text": "plain text persona reply",
  "requestedModel": "gemini-3-flash-preview",
  "provider": "gemini",
  "model": "gemini-3-flash-preview",
  "inputTokens": 432,
  "outputTokens": 37
}
```

If `temperature` is provided, the server must honor that exact value or reject the request clearly.

If `model` is omitted by mistake, the client is still responsible for filling an explicit default before the request is sent.

### 8.3 Why full prompts are sent

We send fully rendered prompts in Phase 1 because it:

- keeps Pathgrade behavior aligned with the current local implementation
- avoids duplicating prompt logic across client and server
- keeps the server thin and deterministic

The tool split still provides Pathgrade-specific auditability and future freedom to move prompt ownership later if desired.

### 8.4 Client Handling of Tool Responses

`McpSClient` returns the top-level `text` field verbatim.

That means:

- `grade_with_llm` returns a JSON-looking string in `text`
- `generate_persona_reply` returns plain text in `text`
- `McpSClient` does not attempt to parse or unwrap the rubric payload inside `text`
- [src/graders/index.ts](/Users/nadavlac/projects/pathgrade/src/graders/index.ts) remains the only component that parses rubric JSON content

This preserves current parser behavior and avoids silent score corruption.

### 8.5 Metadata Semantics and Versioning

`metadata.source` exists for audit attribution, metrics, and server-side routing visibility only.

Phase 1 rules:

- `source` is informational metadata, not prompt content
- `source` must not change model selection behavior by itself
- `source` may be used for dashboards, quotas, or logging policy

`metadata.contractVersion` is the client/server schema guard.

Phase 1 rules:

- client sends `contractVersion: 1`
- server must reject unsupported contract versions with an actionable structured error
- changes to the request or response schema require incrementing the contract version

The server must not own any implicit model defaults for Phase 1. Pathgrade owns default model selection so behavior remains stable across server upgrades.

## 9. CLI Invocation Rules

### 9.1 Call shape

Pathgrade invokes tools by spawning the CLI directly and piping request JSON over stdin.

Required shape:

- executable: validated `mcp-s-cli`
- args: `call <tool>`
- transport: stdin only
- implementation: `child_process.spawn` with `shell: false`
- protocol: write one UTF-8 JSON payload to stdin, then close stdin

Never place prompt content, transcript content, rubric text, or other user-controlled payloads in shell arguments.

### 9.2 Exit-code handling

Map known CLI exit codes to Pathgrade errors.

This mapping is pinned to `@mcp-s/cli` version `0.0.21`, which is the minimum supported version for Phase 1.

- `0`: success
- `1`: client error
- `2`: tool/server error
- `3`: network error
- `4`: auth error

Suggested user-facing messages:

- auth error: instruct the user to run `mcp-s-cli login` or reinitialize auth
- missing CLI: instruct the user to install `@mcp-s/cli`
- network error: identify MCP-S connectivity rather than provider failure

Any exit code `4` must also invalidate the cached auth preflight state.

If a future CLI version returns an unknown code or ambiguous `1`, Pathgrade should fall back to sanitized stderr classification before surfacing a generic failure.

### 9.3 Host auth context

`mcp-s-cli` stores auth state in the host user profile.

Because of that, the MCP-S wrapper must:

- run from the host Pathgrade process
- build its subprocess environment from `process.env`
- allowlist only `PATHGRADE_MCP_S_*` overrides when merging non-host values
- inherit the host `HOME` and `XDG_*` values needed by the CLI
- avoid passing `getRuntimeEnv(runtime)` or any trial-scoped home/xdg overrides into the CLI subprocess
- keep trial-local environment isolation only for agent execution, not for MCP-S host calls

This is an important Phase 1 constraint.

### 9.4 Timeouts and Process Termination

Each CLI invocation must have a bounded timeout.

Default:

- `PATHGRADE_MCP_S_TIMEOUT_MS=90000`

Timeout behavior:

- send `SIGTERM`
- wait briefly for graceful exit
- escalate to `SIGKILL` if needed
- return a normalized timeout error

This is the inner bound for one MCP-S subprocess call. The surrounding grader, conversation, and trial timeouts remain the outer bounds.

### 9.5 Retries

Do not add automatic retries for Phase 1.

LLM-backed operations are not safely idempotent enough to retry blindly, and a retry policy can hide real server bugs or create inconsistent grading behavior.

## 10. CI Behavior

Phase 1 must support both employee machines and CI without requiring the same auth mechanism in both places.

Recommended behavior:

- default `PATHGRADE_LLM_BACKEND=local` in CI and in the initial rollout
- employee machines use explicit `mcp_s` first
- `auto` is optional and should only be enabled where fallback behavior is acceptable
- CI may continue using `local` until MCP-S-compatible CI auth is available
- once CI auth is ready and validated, CI should switch to explicit `mcp_s` first
- only after that validation should CI consider `auto`

This keeps the rollout unblocked by CI auth sequencing.

`mcp_s` is the strict mode for migration and auditing because it fails instead of silently degrading to local keys.

### 10.1 Validation Mode

`pathgrade --validate` must respect the same `PATHGRADE_LLM_BACKEND` resolution rules as normal eval runs.

That means:

- deterministic-only validation remains unchanged
- any `llm_rubric` grader invoked by `--validate` uses the selected backend
- validation runs are subject to the same strict-vs-auto behavior as normal runs
- host `PATHGRADE_*` environment rules apply exactly the same way in validation mode

### 10.2 Persona Latency and Conversation Timeouts

MCP-S persona latency counts against the overall conversation timeout in Phase 1.

Requirements:

- session logs must record persona-call duration separately from agent-turn duration
- timeout diagnostics should make it clear when persona generation consumed the remaining budget
- persona-heavy tasks should increase timeout budgets accordingly

Recommended budgeting guidance:

- add roughly 10 seconds per expected persona-generated turn when using `mcp_s`

## 11. Logging and Observability

Add lightweight call diagnostics for both backends.

Preferred implementation:

- append a new session-log entry for each LLM-backed operation
- append a backend-resolution entry whenever `auto` falls back
- include:
  - backend
  - purpose
  - tool name when applicable
  - selected model
  - requested model
  - provider
  - token counts when available
  - duration
  - success or failure status
  - sanitized fallback or error reason

This is especially useful for distinguishing Pathgrade bugs from MCP-S issues.

Server-side logging requirements for Phase 1:

- do not log raw prompt bodies by default
- do not log raw workspace-derived content at info or error level
- prefer request ids, tool names, `metadata.source`, token counts, sizes, and sanitized error summaries
- any prompt-level debug logging must be disabled in production

## 12. Testing Plan

### Unit tests

- backend resolution for `auto`, `local`, and `mcp_s`
- `local` as the Phase 1 default
- `mcp_s` as strict no-fallback mode
- CLI stdout parsing
- exit-code error mapping
- rejection of unsupported `purpose: 'generic'` under `mcp_s`
- version validation and CLI lookup order
- auth-preflight TTL and invalidation
- verbatim handling of the tool `text` field
- sanitized stderr behavior
- remote short-circuit before local provider inference
- provider validation for remote responses
- `auto` selects `mcp_s` when preflight passes
- `auto` falls back to `local` when preflight fails and keys exist
- `auto` throws when preflight fails and local keys do not exist
- per-trial backend pinning after the first LLM-backed call

### Integration tests

- fake CLI binary that simulates:
  - success
  - auth failure
  - network failure
  - malformed JSON
- host-environment auth resolution, proving that MCP-S uses host `HOME` rather than the trial runtime
- stdin-only payload transport
- shared in-flight preflight under parallel callers
- timeout cleanup that terminates the child process
- staged or mock server contract-version rejection

### Manual verification

1. Local employee flow:
   - no provider API keys
   - valid `mcp-s-cli` install, supported version, and auth
   - persona conversation passes
   - `llm_rubric` grader passes
2. CI flow:
   - `PATHGRADE_LLM_BACKEND=local`
   - existing API-key path still works
3. Staged contract flow:
   - real or staged MCP server
   - response schema validated end to end
   - contract version validated end to end

## 13. Implementation Notes

### 13.1 Prerequisites and Ownership

Client implementation is blocked on a named owner for the Pathgrade MCP server package.

Before Milestone 2 is complete, the owning team must provide:

- the server package location
- deployment environment and access path
- acceptance of the binding tool contracts in Section 8
- a point of contact for schema, rollout, and incident handling

The client/server contract in Section 8 is binding for Phase 1 and requires sign-off from both sides before rollout.

Expected repo changes in Pathgrade:

- [src/utils/llm.ts](/Users/nadavlac/projects/pathgrade/src/utils/llm.ts)
- new `src/utils/mcpS.ts`
- [src/evalRunner.ts](/Users/nadavlac/projects/pathgrade/src/evalRunner.ts)
- [src/conversationRunner.ts](/Users/nadavlac/projects/pathgrade/src/conversationRunner.ts)
- [src/persona.ts](/Users/nadavlac/projects/pathgrade/src/persona.ts)
- [src/graders/index.ts](/Users/nadavlac/projects/pathgrade/src/graders/index.ts)
- [src/types.ts](/Users/nadavlac/projects/pathgrade/src/types.ts) for `LLMExecutionContext` and session-log enrichment
- tests for backend selection and CLI integration

Expected external dependency:

- a Pathgrade MCP server package under `wix-private/mcp-servers`
- named ownership for that package before Milestone 2 completion

## 14. Open Questions

1. What is the final MCP package name and deployment owner?
2. Should CI eventually move to MCP-S, or remain dual-mode long term?
3. Is the two-tool surface final, or should it later collapse into a single internal `call_llm` tool?
4. Do we need model allowlists or per-tool routing policy on the server?
5. Which fields, if any, must be redacted from session-derived prompt content before transmission?

## 15. Decision Summary

Implement a backend-aware LLM boundary in Pathgrade and route only the sensitive LLM-backed features through deterministic `mcp-s-cli` tool calls in Phase 1.

This solves the laptop-secret problem now while preserving the local-first runtime that Pathgrade already depends on.
