# Codex CLI Skill Bootstrap Design

**Date:** 2026-03-27
**Status:** Draft for review
**Owner:** PathGrade feature planning

## Goal

Add first-class Codex CLI integration to PathGrade so `pathgrade --agent=codex` can discover and follow repo-local skills and instructions inside trial workspaces with behavior as close as possible to existing Claude runs.

## Background

PathGrade already supports Codex as an execution agent through `src/agents/codex.ts`. The current gap is not basic command execution. The gap is workspace bootstrapping.

Today the local provider prepares Claude-oriented skill discovery by:

- copying detected skills into workspace-local discovery directories
- generating a workspace `CLAUDE.md` file that advertises available skills

That gives Claude a PathGrade-managed instruction surface during trials. There is no equivalent Codex-specific bootstrap today.

## Problem Statement

When PathGrade runs Codex inside a trial workspace, Codex can execute commands, but local skill discovery is not intentionally provisioned by PathGrade. That creates a mismatch:

- Claude gets explicit workspace-local skill guidance
- Codex mostly depends on ambient repo instructions and user machine setup

This is fragile for both supported auth modes:

- in isolated mode, PathGrade overrides `HOME` and `XDG_*`, so any user-level Codex setup may disappear
- in host-auth mode, Codex may inherit user auth, but skill discovery still depends on whatever happens to exist on the host

PathGrade needs a reproducible Codex bootstrap owned by the trial runtime, not by the developer's personal machine state.

## Scope

### In scope

- PathGrade local provider setup for Codex trial workspaces
- detected repo-local skills as the source of truth
- support for both isolated and host-auth runtime modes
- reproducible Codex instruction discovery inside the trial workspace
- README and author-facing docs for the new behavior
- automated tests for bootstrap generation

### Out of scope

- redesigning PathGrade's entire multi-agent architecture
- inventing a new cross-provider canonical skill format
- changing Codex CLI upstream behavior
- guaranteeing perfect feature parity for provider-specific tool systems

## Current State

Relevant current behavior:

- `src/core/skills.ts` detects skills from root, `skill/`, `skills/`, `.agents/skills/`, and `.claude/skills/`
- `src/providers/local.ts` copies detected skills into `.agents/skills/` and `.claude/skills/`
- `src/providers/local.ts` generates `CLAUDE.md` so Claude can discover the injected skills
- `src/agents/codex.ts` authenticates Codex from `OPENAI_API_KEY` when present, then runs `codex exec`

PathGrade already has the core pieces needed to build a Codex bootstrap:

- skill detection
- isolated workspace creation
- per-trial environment shaping
- a Codex agent entrypoint

The missing piece is Codex-specific instruction materialization.

## Requirements

The feature should satisfy these requirements:

1. Codex runs must discover trial-local skills without relying on the user's existing `~/.codex` setup.
2. The same detected skill set should drive Claude and Codex bootstrap generation.
3. Discovery behavior should be deterministic in both isolated and host-auth modes.
4. If a repo already has its own `AGENTS.md`, PathGrade should preserve that content and compose with it rather than silently discarding it.
5. Repos with no detected skills should continue to run normally.
6. The implementation should stay narrow enough to land as a PathGrade feature, not a framework rewrite.

## Options Considered

### Option 1: `AGENTS.md` only

Generate a workspace-root `AGENTS.md` that lists detected skills and tells Codex where to read them.

Pros:

- smallest implementation
- uses a documented Codex instruction surface
- likely enough for many repos

Cons:

- no Codex-specific runtime bootstrap beyond a single file
- weaker control over consistency across auth modes
- leaves future Codex-specific config hooks scattered

### Option 2: Hybrid Codex bootstrap

Generate a workspace-root `AGENTS.md` and stage detected skills into a PathGrade-owned workspace location so Codex sees a consistent local setup in both auth modes.

Pros:

- deterministic trial behavior
- keeps auth concerns separate from instruction discovery
- narrow enough to land without large architectural churn
- leaves room for future Codex-specific configuration

Cons:

- slightly more implementation than `AGENTS.md` only
- requires careful environment wiring in the local provider

### Future note

The broader provider-unification direction is intentionally not part of this implementation. It is tracked separately in `docs/superpowers/specs/2026-03-27-unified-provider-bootstrap-future.md`.

## Chosen Direction

Choose Option 2: Hybrid Codex bootstrap.

This is the smallest design that reliably solves the actual problem. PathGrade should own Codex instruction discovery inside the trial runtime instead of depending on ambient machine state.

## Design

### Source of truth

`detectSkills()` remains the single source of truth for which skills PathGrade exposes during a run.

### Bootstrap model

During local provider setup, PathGrade should generate agent-facing bootstrap assets from the detected skills set.

For Codex, that means:

- copy detected skill directories into a PathGrade-owned workspace location such as `.pathgrade/skills/`
- generate a workspace-root `AGENTS.md` that advertises available skills and points to their staged `SKILL.md` files
- keep the Codex discovery surface workspace-owned so behavior stays consistent in both auth modes

### `AGENTS.md` composition

PathGrade should treat repo instructions as additive, not replace them.

Recommended composition rule:

- if the task already contains a root `AGENTS.md`, preserve its content
- append a clearly delimited PathGrade-managed section that lists detected skills and their locations
- if no root `AGENTS.md` exists, create one containing only the PathGrade-managed section

This avoids clobbering repo intent while still making skills obvious to Codex.

### Trial-local Codex surface

The Codex discovery surface should be generated inside the trial workspace, not read from the user's real `~/.codex`.

Expected responsibilities:

- stage the skill files Codex should read during the trial
- give `AGENTS.md` a deterministic location to reference
- avoid leaking accidental behavior from user-level machine setup

This does not mean PathGrade must mirror the user's personal Codex home. It means the workspace should be coherent even when user state is absent.

### Auth mode behavior

Instruction discovery and auth should stay separate.

Isolated mode:

- PathGrade keeps using isolated `HOME` and `XDG_*`
- PathGrade provides the Codex bootstrap entirely inside that isolated runtime
- if `OPENAI_API_KEY` is provided, existing Codex login seeding can continue to handle auth

Host-auth mode:

- PathGrade may continue to rely on host credentials when desired
- Codex skill discovery should still come from the trial-local bootstrap, not from whatever the host happens to contain

The goal is parity of discovery behavior across modes, not identical credential mechanics.

### Provider code structure

The local provider should stop inlining all workspace bootstrap logic in one block.

A narrow refactor should extract helpers such as:

- skill directory injection
- Claude instruction file generation
- Codex instruction file generation
- root instruction-file composition

This keeps the change testable without turning it into a large provider rewrite.

## Documentation Impact

The main README should document:

- that Codex is a supported execution agent
- that PathGrade now provisions Codex trial instructions automatically
- any caveats around auth mode versus instruction discovery

Skill author docs should explain that Codex support in PathGrade comes from generated trial bootstrap assets, so authors do not need to hand-maintain separate per-example Codex glue for normal evaluation flows.

## Testing Strategy

### Unit and provider tests

Add tests that verify local provider setup:

- copies skills into the expected trial locations
- generates Codex-facing bootstrap files
- preserves or composes existing `AGENTS.md`
- behaves correctly when no skills are detected
- behaves the same way in isolated and host-auth modes for discovery assets

### Integration coverage

Add at least one integration-style test or fixture-based setup assertion proving that a repo with a detected skill produces a Codex-readable trial workspace.

If practical, extend existing CLI smoke coverage so `--agent=codex` exercises the new bootstrap path under test conditions.

## Risks

- PathGrade could accidentally overwrite user-authored `AGENTS.md` content if composition is implemented carelessly.
- Codex may ignore some inferred local config surfaces even when `AGENTS.md` works, so the design should avoid overcommitting to undocumented behavior.
- Provider setup logic could become harder to reason about if bootstrap responsibilities are not extracted cleanly.

## Non-Goals

- full provider-agnostic skill unification
- generating provider-specific authoring assets in example repos
- changing PathGrade's security model or sandbox model as part of this feature

## Success Criteria

The feature is successful when:

- `pathgrade --agent=codex` reliably sees repo-local skills during local trial runs
- discovery works in both isolated and host-auth modes
- Codex behavior no longer depends on the developer's personal `~/.codex` layout for PathGrade-managed skills
- Claude behavior does not regress
