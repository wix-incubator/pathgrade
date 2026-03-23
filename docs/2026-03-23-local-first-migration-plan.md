# Pathgrade Local-First Migration Plan

**Date:** 2026-03-23
**Status:** In Progress
**Scope:** First architecture slice after the `skillgrade` -> `pathgrade` rename.

## Goal

Make Pathgrade run **locally by default** while keeping the existing **single-turn** flow working.

This slice is complete when:
- `local` is the default execution model
- the CLI, templates, examples, and active docs reflect that default
- single-turn runs still work
- tests pass

## Context

- Product direction: [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-wix-fork-proposal.md)
- Broader architecture background: [docs/2026-03-20-multi-turn-conversations-design.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-20-multi-turn-conversations-design.md)
- Rename checkpoint already landed in commit `4fc35f4`

## Non-Goals

- Do not add multi-turn execution in this slice
- Do not add `eval.ts` support in this slice
- Do not redesign the grader pipeline in this slice
- Do not promise upstream compatibility cleanup beyond what is needed for local-first execution

## Execution Checklist

- [x] Change config defaults from Docker-first to local-first.
  - Update runtime defaults in the config loader.
  - Update template defaults in `templates/eval.yaml.template`.
  - Update example configs that still present Docker as the normal path.

- [x] Change the CLI surface to present local as the default.
  - Update help text and command descriptions.
  - Update README and active architecture docs so local execution is the primary path.
  - Keep Docker mentions only where they are still true for transitional compatibility.

- [x] Simplify the main run path around local execution.
  - Make `LocalProvider` the default provider.
  - Remove Docker-first assumptions from the normal execution path.
  - Decision: keep Docker as a temporary optional fallback for now.

- [ ] Update tests to match the new default behavior.
  - Config tests
  - CLI/help expectations
  - Any tests that assert provider defaults or Docker-first wording

- [ ] Verify the local-first baseline end to end.
  - Run `npm test`
  - Run `npm run build`
  - Run one example locally
  - Confirm the self-eval config is still coherent with the new defaults

## Verification Notes

- Prefer the smallest possible behavior change that proves the boundary:
  local by default, single-turn still functional.
- If Docker support remains temporarily, document it as transitional rather than primary.

## Done Criteria

- [ ] The default mental model of the repo is local-first
- [x] The default config path uses `provider: local`
- [x] The CLI help no longer describes Docker as the default
- [ ] Tests and build pass
- [ ] One local example run has been verified

## Session Handoff

For a fresh session, start with:

1. Read this file.
2. Read [docs/2026-03-23-wix-fork-proposal.md](/Users/nadavlac/projects/pathgrade/docs/2026-03-23-wix-fork-proposal.md).
3. Execute the next unchecked item in order.

Suggested opener:

`Continue Pathgrade migration from docs/2026-03-23-local-first-migration-plan.md. Read that file and docs/2026-03-23-wix-fork-proposal.md, then execute the next unchecked item.`
