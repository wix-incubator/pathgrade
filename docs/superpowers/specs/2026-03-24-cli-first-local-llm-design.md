# CLI-First Local LLM Runtime Design

**Date:** 2026-03-24
**Status:** Draft for review
**Owner:** Pathgrade design exploration

## Goal

Explore whether Pathgrade can revise its local LLM-backed behavior so local runs use the user's available authenticated CLIs instead of provider API keys, while CI can still use API-key-backed execution when needed.

## Background

Pathgrade currently uses two different local execution models:

- The main eval agent runs inside a per-trial isolated runtime with a temporary workspace and temporary `HOME` / `XDG_*` directories.
- `llm_rubric`, persona generation, and `pathgrade init` use direct provider API calls through `src/utils/llm.ts`.

That means:

- deterministic shell work does not need model auth
- local LLM-backed calls currently require provider API keys
- a user's normal host CLI login state is not a supported foundation for local keyless runs

The design goal for this exploration is to determine whether Pathgrade can move to a CLI-first local model without committing to an implementation plan that assumes unverified auth behavior.

## Problem Statement

The current plan for removing local provider API keys assumes a separate remote backend for sensitive LLM-backed features. A different possible direction is to use the user's already authenticated local CLIs such as Claude Code or Codex.

The main uncertainty is not prompt construction. It is auth and runtime boundaries:

- The solver agent needs to act on an isolated trial workspace.
- The judge-style and generator-style flows need authenticated prompt-in / text-out behavior.
- Local CLIs may depend on host login state that is not visible inside Pathgrade's isolated trial runtime.

Before revising the architecture or implementation plan, Pathgrade needs direct evidence about what each CLI can and cannot do.

## Terms

- **Solver:** The main eval agent being tested. It receives the eval instruction and attempts to solve the task inside the eval workspace.
- **Judge:** An LLM-backed flow that scores or generates text but does not need autonomous workspace execution. In this exploration, that includes `llm_rubric`, persona reply generation, and `pathgrade init`.
- **Trial environment:** The isolated per-trial runtime Pathgrade creates for workspace execution.
- **Host environment:** The user's real machine environment, including the real `HOME`, installed CLIs, and login state.

## Environment Model

### Trial environment

The trial environment is where eval work happens. It should remain isolated and reproducible.

Properties:

- temporary workspace copied from task fixtures
- temporary `HOME`
- temporary `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`
- temporary `TMPDIR`

Responsibilities:

- solver file edits
- solver shell commands
- deterministic graders

### Host environment

The host environment is the real machine environment outside the trial.

Properties:

- real `HOME`
- real CLI login state
- real global CLI configuration
- installed local CLIs such as `claude` and `codex`

Responsibilities:

- candidate local auth source for CLI-first LLM behavior
- candidate execution environment for judge-style prompt-in / text-out flows

## Key Clarification

Pathgrade can launch the solver inside the trial environment and still fail to authenticate that solver if the CLI depends on host-stored login state.

This distinction matters:

- **where work happens** is the trial workspace boundary
- **where auth comes from** is the login-state boundary

The design exploration should not assume those two boundaries must stay coupled.

## Architecture Options Considered

### Option 1: Keep the current remote-backend plan

Use a host-scoped remote backend for local keyless LLM-backed behavior and leave the local CLI path unchanged.

Pros:

- smallest change to current assumptions
- avoids local CLI auth variance
- already documented in the current draft plans

Cons:

- does not test whether local CLIs are enough on their own
- adds infrastructure dependency and data-transmission concerns

### Option 2: Reuse agent sessions for everything

Use the same general agent/session mechanism for solver, rubric, persona, and init generation.

Pros:

- one conceptual execution model
- simpler to explain at a high level

Cons:

- mixes autonomous solver behavior with bounded text generation
- does not solve host-auth versus trial-auth separation
- risks overfitting judge behavior to agent tooling behavior

### Option 3: CLI-first local runtime with evidence first

Treat local keyless support as a capability question. First run a CLI-by-CLI POC. Only then revise the implementation plan based on what is proven.

Pros:

- avoids building around unverified assumptions
- keeps the architecture evidence-driven
- allows different conclusions per CLI

Cons:

- adds a discovery phase before implementation planning
- may reveal that the desired architecture only works partially

## Chosen Direction

Choose Option 3.

Before revising Pathgrade's main implementation plan, build a standalone CLI-by-CLI POC that measures whether local authenticated CLIs can support:

- judge-style prompt-in / text-out automation from the host environment
- solver behavior against an isolated workspace while using host login state
- a possible auth bridge into an isolated trial-like environment

This POC should remain outside the production runtime.

## POC Scope

The first POC must cover both judge and solver behavior.

### In scope

- Claude, Codex, and Gemini if installed
- host-authenticated judge-style execution
- host-authenticated solver execution against a temporary workspace
- targeted inspection of local CLI state if needed
- trial-bridge experiments only when justified by earlier probe results
- repeatable machine-readable results

### Out of scope

- rewriting Pathgrade production runtime
- cross-platform support claims
- CI architecture changes
- security sign-off
- claims that a bridge is production-ready

## POC Probe Design

Each CLI gets the same conceptual probes.

### Probe 1: `host_judge`

Purpose:

- verify that the CLI can handle judge-style prompt-in / text-out work from the host environment without provider API keys

Method:

- run from the real host environment
- unset provider API key env vars for the subprocess
- send a tight prompt that must return a tiny JSON object and nothing else

Pass criteria:

- command succeeds
- response is parseable automatically
- no provider API key is needed

### Probe 2: `host_solver`

Purpose:

- verify that the CLI can operate against a temporary workspace while still using host-authenticated login state

Method:

- create a temporary workspace with a small fixture file
- run the CLI with `cwd` set to that workspace
- ask it to make one precise file change and emit a short completion message

Pass criteria:

- command succeeds
- expected file change happens in the temporary workspace
- no provider API key is needed

### Probe 3: `trial_bridge`

Purpose:

- determine whether a true trial-like isolated runtime can be authenticated by staging minimal CLI auth/session state

Method:

- only run if `host_judge` and `host_solver` succeed
- create a trial-like temp root with isolated `HOME`, `XDG_*`, and `TMPDIR`
- use a CLI-specific staging strategy to copy or link only the minimum candidate auth/session material
- rerun a reduced judge probe and solver probe

Pass criteria:

- isolated-home judge probe succeeds
- isolated-home solver probe succeeds
- no provider API key is needed

## Output Contract

The POC harness must write a machine-readable result matrix per CLI with at least these fields:

- `cli`
- `installed`
- `host_auth_available`
- `judge_ok`
- `solver_ok`
- `bridge_attempted`
- `bridge_ok`
- `failure_code`
- `failure_reason`
- `notes`

Each probe should also preserve evidence:

- command line used
- sanitized env diff
- exit code
- stdout and stderr
- parsed verdict
- filesystem assertions for solver probes
- notes about any auth artifacts touched during bridge attempts

## Failure Classification

The POC must classify failures instead of collapsing them into a generic failure bucket.

Expected failure classes:

- CLI not installed
- CLI installed but not authenticated
- CLI authenticated but output format is unusable for automation
- CLI can judge but cannot solve against a temporary workspace
- CLI can solve with host auth but bridge attempt fails
- CLI behavior is too interactive or flaky to trust

Canonical `failure_code` values for the POC:

- `not_installed`
- `not_authenticated`
- `output_unparseable`
- `workspace_write_failed`
- `bridge_failed`
- `interactive_or_flaky`
- `unexpected_error`

The revised architecture should only respond to failures that actually signal architectural constraints.

## File Layout

Keep the POC clearly outside the production runtime.

Proposed layout:

- `scripts/cli-poc/run.ts`
- `scripts/cli-poc/types.ts`
- `scripts/cli-poc/probes/claude.ts`
- `scripts/cli-poc/probes/codex.ts`
- `scripts/cli-poc/probes/gemini.ts`
- `scripts/cli-poc/fixtures/solver-workspace/*`
- `tests/cli-poc.test.ts`
- `docs/cli-poc/2026-03-24-cli-auth-findings.md`

Rationale:

- avoid turning an unproven design into a production abstraction too early
- keep probe-specific code easy to delete or promote later
- make findings reviewable before architecture work begins

## Decision Gates After the POC

The implementation plan should branch based on proven capabilities.

### Green light

Conditions:

- at least one target CLI passes both `host_judge` and `host_solver`
- judge outputs are automation-friendly enough for `llm_rubric`, persona, or init

Implication:

- revise the implementation plan around CLI-first local execution for the supported roles

### Partial green light

Conditions:

- at least one target CLI passes `host_judge`
- no target CLI cleanly passes both `host_judge` and `host_solver`
- solver probes are mixed or inconclusive

Implication:

- revise only the local judge-style flows first
- keep solver architecture unchanged until solver auth is proven

### Red light

Conditions:

- even host-scoped judge behavior is not reliable enough

Implication:

- do not revise Pathgrade around a CLI-first local LLM architecture
- keep the current remote or API-backed direction

## Important Constraint on Bridge Claims

The `trial_bridge` concept is not yet a supported design assumption.

At this stage it should be treated only as a hypothesis to test, because different CLIs may:

- store auth in different locations
- depend on OS-managed secrets
- couple auth and session history in non-portable ways
- change behavior across versions

The revised implementation plan must not assume a generic bridge exists unless the POC proves one for a specific CLI.

If `host_solver` works and `trial_bridge` fails, the architecture should prefer host-auth passthrough over inventing a fake generic bridge.

## Success Criteria for This Design Phase

This design phase is successful if it produces:

- a standalone repeatable probe harness design
- clear pass/fail criteria per CLI and per role
- an evidence threshold for revising the implementation plan
- explicit separation between proven behavior and unverified assumptions

## Open Questions

- Which CLIs can emit stable machine-readable output with minimal post-processing?
- Which CLIs can act on a temporary workspace while using host login state?
- Does any CLI support a safe and repeatable isolated-home bridge?
- If CLIs differ materially, should Pathgrade expose capability-based routing instead of a single uniform local backend?

The last question is explicitly a post-POC architecture decision. The POC harness itself does not need to solve routing design.

## Recommendation

Do not revise the main Pathgrade implementation plan yet.

First, run the CLI-by-CLI POC described in this document. Use the findings to decide whether Pathgrade should pursue:

- CLI-first local judge flows only
- CLI-first local judge plus solver flows
- or no CLI-first local redesign at all
