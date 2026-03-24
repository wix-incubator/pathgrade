# Pathgrade MCP-S Remote LLM Backend PRD

**Date:** 2026-03-23
**Status:** Draft
**Scope:** Phase 1 hybrid rollout for secure LLM-backed grading and persona simulation.

## Summary

Pathgrade should support secure local use by Wix employees without requiring model-provider API keys on employee laptops.

The proposed Phase 1 solution is a hybrid runtime:

- keep the main agent execution loop local
- move rubric-based grading and persona reply generation behind a Pathgrade-owned MCP server
- invoke those remote tools deterministically from Pathgrade via `@mcp-s/cli`
- rely on Wix-authenticated MCP-S access on employee machines instead of distributing provider API keys

This feature solves the immediate security blocker for employee usage when Pathgrade is launched through an internal entrypoint that enables the secure backend without forcing a rewrite of the local trial runtime.

## Problem Statement

Pathgrade is intended to run in two environments:

- CI
- Wix employee machines

Today, the LLM-backed parts of Pathgrade call provider APIs directly from the local process. That creates two problems:

1. Employee machines would need OpenAI, Anthropic, or Gemini API keys to run rubric graders and persona-based conversations.
2. We do not want those secrets on employee laptops for security and operational reasons.

The direct-call model blocks broader internal adoption even though the rest of Pathgrade is already designed to run locally.

## Why Now

The MCP-S team now provides a real CLI, `@mcp-s/cli`, that can invoke MCP tools deterministically through the Wix MCP gateway. This creates a practical path to:

- keep secrets server-side
- authenticate employee usage via Wix SSO
- call remote tools from code without relying on an agent to decide when to use them

That makes the blocker solvable with a focused architecture slice instead of a full platform migration.

## Goals

1. Remove the need for model-provider API keys on employee laptops for Pathgrade's LLM-backed features.
2. Preserve local Pathgrade workflows for eval authors and maintainers.
3. Support the same codebase in both employee environments and CI.
4. Use deterministic remote tool invocation rather than agent-mediated MCP usage.
5. Keep the Phase 1 implementation small by changing only the LLM-backed parts of the runtime.
6. Provide actionable failures when the CLI is missing, auth is expired, or the remote service is unavailable.
7. Make the remote transport safe by design: no prompt content in shell arguments, no reliance on trial-isolated auth paths, and bounded subprocess execution.
8. Document and review the eval content transmitted through Wix infrastructure before production rollout.
9. Make the employee launch path default to secure mode even while the repository-wide backend default remains `local` for rollout safety.

## Non-Goals

1. Do not move the full agent execution loop remote in Phase 1.
2. Do not replace the local workspace runtime or command execution model.
3. Do not redesign the `eval.yaml` task model for this slice.
4. Do not require CI to use MCP-S on day one if direct API-backed fallback remains necessary.
5. Do not generalize this into a remote compute platform for every Pathgrade capability.

## Users and Stakeholders

### Primary users

- Wix employees running Pathgrade locally
- Pathgrade maintainers
- Eval authors who depend on persona simulation and rubric grading

### Stakeholders

- The team owning Pathgrade
- The team owning the Pathgrade MCP server
- MCP-S and Wix infra teams
- Security reviewers

## User Stories

### Story 1: Local secure run

As a Wix employee, I want to run Pathgrade locally without model-provider API keys on my machine, so I can use the tool safely with standard Wix auth.

### Story 2: No workflow regression

As an eval author, I want existing persona-based and rubric-based evals to keep working with minimal or no task-level config changes.

### Story 3: CI compatibility

As a maintainer, I want the same Pathgrade codebase to run in CI even if CI auth differs from employee-machine auth.

### Story 4: Actionable failures

As a developer, I want Pathgrade to tell me whether a failure is caused by missing CLI install, missing auth, network issues, or MCP tool failure.

## Functional Requirements

1. Pathgrade must support a remote backend for LLM-backed rubric grading.
2. Pathgrade must support a remote backend for LLM-backed persona reply generation.
3. Pathgrade must invoke the remote backend deterministically via `mcp-s-cli`.
4. Employee-machine usage must authenticate via the existing Wix MCP-S auth flow rather than local provider keys.
5. Pathgrade must keep existing local agent execution unchanged in Phase 1.
6. Pathgrade must support backend selection so CI can continue to run even if it does not use the same auth path as employee machines.
7. Pathgrade must preserve existing model override behavior where possible.
8. Pathgrade must surface clear errors for:
   - missing `mcp-s-cli`
   - failed or expired auth
   - network failures
   - server/tool failures
   - malformed tool responses
9. Internal employee entrypoints, onboarding docs, or wrapper commands must set `PATHGRADE_LLM_BACKEND=mcp_s` explicitly for employee-machine usage.
10. Runtime control variables such as `PATHGRADE_LLM_BACKEND` and `PATHGRADE_MCP_S_*` must be treated as host-process configuration, not task-level `.env` settings.

## Non-Functional Requirements

### Security

- Provider API keys for remote LLM calls must remain server-side.
- Employee laptops must not require provider API keys for Phase 1 functionality.
- The design should rely on Wix identity and infrastructure for employee authentication.
- The design must explicitly document what eval content is transmitted to the remote backend.
- Production rollout requires security and compliance sign-off for the transmitted data classes.

### Data Handling

- Remote prompt payloads may include task instructions, conversation transcripts, rubric text, command stdout/stderr, prior grader output, and generated code snippets that appear in logs.
- The feature must not assume that "no API keys on laptops" is the only security concern.
- The rollout must define what content is allowed to leave the local process and what must be redacted or blocked.

### Reliability

- Failures must degrade predictably and be diagnosable.
- CI must retain a supported execution path even if MCP-S auth is not yet available there.
- Hung CLI calls must time out and fail cleanly instead of blocking workers indefinitely.

### Maintainability

- Phase 1 should reuse the current local runtime and isolate changes to the LLM-backed boundary.
- Prompt and grading behavior should remain as close as possible to current Pathgrade behavior.

### Performance

- Added latency from remote calls is acceptable for grading and persona simulation, but should stay bounded and visible.

## Success Metrics

1. Using the documented employee launch path, a Wix employee can run Pathgrade locally without setting `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`.
2. Existing persona-based conversation evals continue to run with the remote backend enabled.
3. Existing `llm_rubric` graders continue to run with the remote backend enabled.
4. CI remains green using either the remote backend or the existing local-provider fallback.
5. Pathgrade failures distinguish auth issues from tool/server failures.
6. No provider secrets are added to employee-machine setup instructions.
7. Security/compliance review is completed before production enablement.
8. Employee onboarding does not require developers to remember a per-run backend flag.

## Proposed Product Shape

### Phase 1

- Introduce a remote LLM backend for:
  - `llm_rubric` grading
  - persona reply generation
- Keep:
  - local agent CLI execution
  - local workspace isolation
  - current conversation orchestration

### Phase 2 later

- Re-evaluate whether some or all of the agent-turn execution should move remote.
- This is explicitly out of scope for the current feature.

## Rollout Plan

### Milestone 1: POC

- Stand up a Pathgrade MCP tool surface
- Prove deterministic invocation with `mcp-s-cli call` using stdin-only payload transport
- Validate employee-machine auth flow
- Pin and validate a minimum supported `@mcp-s/cli` version
- Verify that CLI auth is resolved from the host environment, not the trial runtime
- Define the staged contract test between Pathgrade and the server response schema

### Milestone 2: Runtime integration

- Add an MCP-S-backed LLM path in Pathgrade
- Route rubric grading and persona replies through it
- Keep `PATHGRADE_LLM_BACKEND=local` as the Phase 1 default
- Use explicit `mcp_s` on employee machines and keep `auto` opt-in only
- Ship an employee entrypoint, wrapper, or onboarding flow that exports `PATHGRADE_LLM_BACKEND=mcp_s` and any required `PATHGRADE_MCP_S_*` host env settings
- Preserve local/API-key fallback for CI and controlled environments
- Resolve server ownership before this milestone is considered complete

### Milestone 3: Stabilization

- Add tests, docs, and failure diagnostics
- Validate at least one local employee flow and one CI flow
- Add contract coverage against a staged or real server
- Complete security/compliance sign-off for transmitted eval content
- Re-evaluate whether `auto` should become the default only after CI auth is proven

## Risks

1. `mcp-s-cli` auth state is stored globally on the host, which may constrain sandboxing assumptions.
2. CI auth through MCP-S may not be ready on the same timeline as employee-machine auth.
3. Remote service latency or outages can affect eval duration and reliability.
4. A thin client / smart server split must be chosen carefully to avoid prompt drift between backends.
5. The feature transmits eval content through Wix infrastructure, which may trigger data-handling review requirements beyond secret management.

## Open Questions

1. Will CI use MCP-S immediately, or keep the direct-provider fallback until service auth is ready?
2. Which team will own the Pathgrade MCP server package and deployment lifecycle?
3. Should the server expose two Pathgrade-specific tools or a more generic internal LLM tool surface?
4. What observability is required for per-call auditing, quota management, and incident response?
5. Which log content must be redacted locally before it can be sent or persisted?

## Decision

Proceed with the hybrid Phase 1 design:

- remoteize rubric grading and persona reply generation via MCP-S
- keep the main agent loop local
- keep `PATHGRADE_LLM_BACKEND=local` as the initial default for rollout safety
- use explicit `mcp_s` for employee-machine adoption first
- make the documented employee launch path set secure mode automatically
- support CI through backend selection instead of forcing one auth model everywhere on day one
