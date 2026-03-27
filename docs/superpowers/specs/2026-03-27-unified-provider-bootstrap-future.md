# Unified Provider Bootstrap Framework Future Design

**Date:** 2026-03-27
**Status:** Future exploration only
**Owner:** PathGrade feature planning

## Purpose

Capture the deferred Option 3 direction separately so the Codex bootstrap implementation can stay narrow.

## Why this is deferred

The current feature only needs Codex run-time parity for repo-local skill discovery. A full provider-unification effort would widen scope substantially and introduce unnecessary regression risk while the Codex bootstrap contract is still being proven.

## Future goal

When PathGrade has at least two stable provider-specific bootstrap surfaces, replace ad hoc workspace setup code with a single bootstrap manifest plus provider renderers.

## Candidate shape

A future implementation could introduce:

- a shared bootstrap manifest that describes detected skills and root instruction composition
- provider renderers for Claude, Codex, and future agents
- one provider entrypoint that materializes staged files from the manifest

## Good reasons to revisit this

- provider setup logic becomes duplicated across multiple files
- a third provider needs repo-instruction bootstrapping
- tests become repetitive because each provider re-implements the same staging logic
- PathGrade wants one author-facing contract for generated agent assets

## Explicit non-goal for the current feature

This document is not an implementation target for the Codex bootstrap feature. The current implementation plan should cover Option 2 only.
