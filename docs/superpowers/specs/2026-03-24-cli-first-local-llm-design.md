# CLI-First Local LLM Runtime Design

**Date:** 2026-03-24
**Status:** Draft for review
**Owner:** Pathgrade design exploration

## Goal

Explore whether Pathgrade can revise its local LLM-backed behavior so local runs use the user's available authenticated CLIs instead of provider API keys, while CI can still use API-key-backed execution when needed.

## Background

Pathgrade currently uses two different local execution models:

- The main eval agent runs inside a per-trial isolated runtime with a temporary workspace and temporary `HOME` / `XDG_*` directories.
- `llm_rubric` and persona generation use direct provider API calls through `src/utils/llm.ts`.
- `pathgrade init` has its own provider-specific `fetch()` implementation in `src/commands/init.ts`.

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

## Current Local LLM Call Surfaces

The current local LLM-backed surfaces that matter for this exploration are:

- solver agent CLI invocations in `src/agents/*.ts`
- rubric grading in `src/graders/index.ts` via `src/utils/llm.ts`
- persona generation in `src/persona.ts` via `src/utils/llm.ts`
- eval initialization in `src/commands/init.ts` via provider-specific `fetch()` calls

The POC and any later decision gates must account for each surface explicitly. A positive result for rubric grading alone is not enough to claim that local CLI-first behavior can replace the entire current local API-backed model.

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

## Per-CLI Auth Characterization

Each CLI must be characterized before any behavioral probe runs.

The characterization step is mandatory and must document:

- binary name and resolved path
- CLI version from `--version`
- available auth commands such as `claude auth status` or `codex login status`
- working hypothesis for the CLI's auth model
- what "keyless" means for that CLI
- which environment variables must be unset
- which environment variables must be preserved
- which auth or session artifacts are present before probing
- whether a trial-side bridge is even coherent for that CLI
- which exact flags will be used for each probe

Initial expectations must stay grounded in observed behavior:

- Claude exposes `claude auth status`; `--bare` must not be used for auth characterization because its help text explicitly disables OAuth and keychain reads.
- Codex exposes `codex login status` and `codex login --with-api-key`; the current Pathgrade adapter already re-seeds Codex auth from `OPENAI_API_KEY`, so "keyless" support for Codex is unproven and must be demonstrated rather than assumed.
- Gemini is conditional. A Gemini probe only enters scope after the actual installed CLI binary name, auth surface, and local auth mechanism are identified on the machine under test.

## POC Scope

The first POC must cover both judge and solver behavior.

### In scope

- per-CLI auth characterization before any behavior probe
- Claude and Codex on machines where they are installed
- Gemini only after its concrete CLI binary and auth model are identified
- host-authenticated rubric-style execution
- host-authenticated persona-style execution
- host-authenticated init-style generation
- host-authenticated solver execution against a temporary workspace
- mandatory isolated-home auth smoke testing
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

Each CLI gets the same probe stages, but the exact auth expectations and flag selections come from that CLI's characterization step.

### Probe 0: `auth_characterization`

Purpose:

- document the auth model and exact probe contract for the CLI under test before any capability claim is made

Method:

- record CLI path and version
- inspect supported auth commands
- inventory relevant auth and session artifacts without reading secret contents
- record which provider key env vars are present as booleans only
- define exact probe flags for this CLI
- define whether "keyless" is a coherent expectation for this CLI

Pass criteria:

- the auth model, keyless hypothesis, env handling, and probe flags are explicit enough that later probe results are interpretable

### Consumer fixtures

Behavior probes must target actual Pathgrade consumer schemas, not generic "valid JSON."

- `rubric_schema`
  - exact target shape: `{"score": <number>, "reasoning": "<string>"}`
- `persona_text`
  - exact target shape: a single plain-text reply with no tool chatter
- `init_yaml`
  - exact target shape: parseable YAML with `version`, `defaults`, and `tasks`
- `solver_workspace`
  - exact target shape: one precise file edit in a temporary workspace

### Probe 1: `host_rubric`

Purpose:

- verify that the CLI can handle `llm_rubric`-style prompt-in / structured-output work from the host environment without provider API keys

Method:

- run from the real host environment
- apply CLI-specific env handling from characterization
- send a rubric-style prompt that must satisfy the exact `rubric_schema`

Pass criteria:

- command succeeds
- response satisfies the exact `rubric_schema`
- no provider API key values were available to the subprocess
- auth artifact inventory is recorded alongside the result

### Probe 2: `host_persona`

Purpose:

- verify that the CLI can handle persona-style plain-text generation from the host environment without provider API keys

Method:

- run from the real host environment
- apply CLI-specific env handling from characterization
- send a persona-style prompt that must produce plain text only

Pass criteria:

- command succeeds
- output is plain text with no tool transcript or protocol framing
- no provider API key values were available to the subprocess
- auth artifact inventory is recorded alongside the result

### Probe 3: `host_init`

Purpose:

- verify that the CLI can replace `src/commands/init.ts` style generation instead of leaving init as a hidden API-key dependency

Method:

- run from the real host environment
- apply CLI-specific env handling from characterization
- send an init-style prompt that must return parseable YAML with the `init_yaml` shape

Pass criteria:

- command succeeds
- output parses as YAML
- output contains `version`, `defaults`, and `tasks`
- no provider API key values were available to the subprocess
- auth artifact inventory is recorded alongside the result

### Probe 4: `isolated_home_smoke`

Purpose:

- answer the most important architectural question early: what happens to CLI auth when `HOME`, `XDG_*`, `TMPDIR`, `TMP`, and `TEMP` are overridden

Method:

- run a reduced rubric-style probe
- override `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `TMP`, and `TEMP`
- do not stage any bridge material yet

Pass criteria:

- result clearly shows whether auth survives or fails under overridden home-state conditions

### Probe 5: `host_solver`

Purpose:

- verify that the CLI can operate against a temporary workspace while still using host-authenticated login state

Method:

- create a temporary workspace with a small fixture file
- run the CLI with `cwd` set to that workspace
- apply CLI-specific solver flags from characterization
- ask it to make one precise file change and emit a short completion message

Pass criteria:

- command succeeds
- expected file change happens in the temporary workspace
- no provider API key values were available to the subprocess
- auth artifact inventory is recorded alongside the result

### Probe 6: `trial_bridge`

Purpose:

- determine whether a true trial-like isolated runtime can be authenticated by staging minimal CLI auth/session state

Method:

- only run if characterization suggests a bridge is coherent and the earlier probes justify deeper testing
- create a trial-like temp root with isolated `HOME`, `XDG_*`, `TMPDIR`, `TMP`, and `TEMP`
- stage only the minimum candidate auth/session material for that CLI
- rerun reduced rubric and solver probes

Pass criteria:

- isolated-home rubric probe succeeds
- no provider API key is needed
- isolated-home solver probe succeeds
- staged artifacts are cleaned up reliably afterward

## Output Contract

The POC harness must write a machine-readable result object per CLI with top-level metadata plus per-probe result objects.

Top-level fields:

- `cli`
- `binary_path`
- `cli_version`
- `auth_characterization`
- `aggregate`
- `notes`

Each probe result must be its own object with at least:

- `ok`
- `failure_code`
- `failure_reason`
- `timeout_sec`
- `command`
- `env_observation`
- `auth_artifact_inventory`
- `evidence`

Required probe result keys:

- `host_rubric`
- `host_persona`
- `host_init`
- `isolated_home_smoke`
- `host_solver`
- `trial_bridge` when attempted

Probe evidence should preserve:

- command line used
- sanitized env diff
- exit code
- stdout and stderr
- parsed verdict
- filesystem assertions for solver probes
- notes about any auth artifacts touched during bridge attempts

The sanitized env diff must use an allowlist. It should include:

- `HOME`
- `XDG_CONFIG_HOME`
- `XDG_STATE_HOME`
- `XDG_CACHE_HOME`
- `TMPDIR`
- `TMP`
- `TEMP`
- `PATH`
- boolean presence flags only for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and any other provider-key variables relevant to the CLI under test

## Failure Classification

The POC must classify failures per probe instead of collapsing them into a generic failure bucket.

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

### Probe timeouts

Timeouts are mandatory.

- `auth_characterization`: 15 seconds
- `host_rubric`: 30 seconds
- `host_persona`: 30 seconds
- `host_init`: 60 seconds
- `isolated_home_smoke`: 30 seconds
- `host_solver`: 120 seconds
- `trial_bridge`: 120 seconds

If a process is still running at timeout, record `interactive_or_flaky`.

## Initial CLI Probe Commands

The characterization step owns the final command lines, but the first implementation should start from these explicit defaults.

### Claude

- `host_rubric`
  - `claude -p --output-format json --json-schema <schema-file> --tools "" --no-session-persistence`
- `host_persona`
  - `claude -p --output-format text --tools "" --no-session-persistence`
- `host_init`
  - `claude -p --output-format text --tools "" --no-session-persistence`
- `isolated_home_smoke`
  - same as `host_rubric`, but with overridden `HOME`, `XDG_*`, `TMPDIR`, `TMP`, and `TEMP`
- `host_solver`
  - `claude -p --dangerously-skip-permissions --no-session-persistence`

Notes:

- do not use `--bare` for these probes because Claude's help text says it disables OAuth and keychain reads
- do not use `--dangerously-skip-permissions` for judge-style probes

### Codex

- `host_rubric`
  - `codex exec --ephemeral --sandbox read-only --skip-git-repo-check --output-schema <schema-file> -o <output-file> -C <temp-dir> -`
- `host_persona`
  - `codex exec --ephemeral --sandbox read-only --skip-git-repo-check -o <output-file> -C <temp-dir> -`
- `host_init`
  - `codex exec --ephemeral --sandbox read-only --skip-git-repo-check -o <output-file> -C <temp-dir> -`
- `isolated_home_smoke`
  - same as `host_rubric`, but with overridden `HOME`, `XDG_*`, `TMPDIR`, `TMP`, and `TEMP`
- `host_solver`
  - `codex exec --ephemeral --full-auto --skip-git-repo-check -C <workspace-dir> -`

Notes:

- `codex login status` is mandatory during characterization
- Codex only counts as keyless-supported if the probe succeeds with provider key vars absent

### Gemini

Do not define probe commands until the actual CLI binary, auth surface, and flag semantics are characterized on a machine where the Gemini CLI is installed.

## Trial Bridge Safety Requirements

Any bridge attempt is a credential operation and must follow explicit safety rules.

- create bridge directories with `0700` permissions
- prefer copies over symlinks
- never stage an entire home directory
- never record secret contents in evidence
- always clean staged material in a `finally` block, even after failure

## Integration Feasibility

The current judge-style flows are in-process HTTP calls, not CLI subprocesses. Replacing them with subprocess execution changes:

- cold-start latency
- stdout parsing fragility
- connection reuse behavior
- session persistence behavior

The POC must therefore record timing and output stability for:

- rubric-style output
- persona-style output
- init-style YAML generation

A successful capability probe is necessary but not sufficient. The later implementation plan must still decide whether a given call site is practical to move to a CLI subprocess path.

## Host-Auth Passthrough

Host-auth passthrough is a concrete fallback architecture, not just a phrase.

Definition:

- run the CLI subprocess with host authentication intact
- keep the working directory pointed at a temporary workspace
- do not copy auth into the trial home

This is what `host_solver` measures. If `host_solver` works and `trial_bridge` fails, the later implementation plan should treat host-auth passthrough as the primary solver architecture candidate rather than inventing a generic bridge.

## File Layout

Keep the POC clearly outside the production runtime.

Proposed layout:

- `scripts/cli-poc/run.ts`
- `scripts/cli-poc/types.ts`
- `scripts/cli-poc/probes/claude.ts`
- `scripts/cli-poc/probes/codex.ts`
- `scripts/cli-poc/probes/gemini.ts` only after Gemini CLI characterization confirms a real target
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

- at least one target CLI passes `host_rubric`, `host_persona`, `host_init`, and `host_solver`
- the mandatory `isolated_home_smoke` result is recorded for that CLI
- rubric output satisfies the exact score-and-reasoning schema used by `llm_rubric`

Implication:

- revise the implementation plan around CLI-first local execution for the supported roles

### Partial green light

Conditions:

- at least one target CLI passes `host_rubric`
- persona or init either pass or are explicitly excluded from the first implementation revision
- no target CLI cleanly passes the full green-light set
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
