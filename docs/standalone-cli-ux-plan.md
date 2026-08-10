# Standalone CLI UX plan

## Outcome

Make `pathgrade standalone` pleasant in an interactive terminal without weakening
its behavior in CI, redirected output, or failure cases. Project-local Pathgrade
runs remain unchanged.

## Two views

### Calm Runner (default)

Show a small, bounded list of active eval cases, persist completed cases, and end
with an authoritative report summary. In a capable TTY the active rows animate;
CI and redirected output receive stable, line-oriented text.

### Live Trace (`--verbose`)

Keep the existing append-only agent event stream, but label every line with its
agent and use semantic color. This view favors diagnosis over compactness and
does not use an in-place dynamic region.

## Visual language

Use one brand accent plus semantic colors, never color alone:

- green: pathgrade identity and successful completion
- cyan: active work, tools, and artifact paths
- yellow: warnings and retries
- red: failures and errors
- magenta: reactions and judge/LLM score labels
- neutral bold/dim: structure and optional metadata

Use named ANSI colors, no colored backgrounds, and retain status words. Respect
the outer output stream's color capabilities, `NO_COLOR`, `FORCE_COLOR`, dumb
terminals, and CI. Restrict decorative Unicode and animation to capable TTYs.

## Architecture

- Standalone Vitest uses its `minimal` reporter plus `PathgradeReporter`.
  Minimal preserves assertion stacks, collection errors, unhandled errors, and
  no-test diagnostics without duplicating the full default UI.
- `PathgradeReporter` emits versioned lifecycle events over dedicated file
  descriptor 3. Events contain names, state, durations, counts, report metrics,
  and artifact paths—never prompts, tool arguments, secrets, or raw errors.
- The standalone parent parses the NDJSON stream and owns terminal redraws.
  Unknown or malformed protocol disables the rich renderer, warns once, and
  leaves raw Vitest output and exit behavior intact.
- Report completion is emitted only after `.pathgrade` artifacts are written.
  Final status and score come from the built report, not renderer counters.

## Behavior contract

- Default: Calm Runner and final summary.
- `--verbose`: Live Trace plus final summary.
- `--quiet`: failures, warnings, and final status only.
- `--diagnostics`: expands final diagnostics independently of progress mode.
- `--quiet --verbose`: fail fast as mutually exclusive.
- JSON reporter: no Calm UI or Pathgrade CLI summary; artifacts still written.
- Browser reporter: Calm/Trace first, then open the viewer.
- Successful arbitrary `console.log` output remains suppressed by Vitest minimal.
- Preserve concurrency. Show at most six active rows and summarize overflow.
- A no-`evaluate()` compatibility pass displays PASS without a fabricated score.
- Numeric scores are neutral unless an explicit threshold determines status.
- `pass@k` and `pass^k` appear only for comparable groups with at least two trials.

## Delivery slices

1. Correct scoped help/version, credential messaging, and flag conflicts.
2. Add stream-aware theme and width-safe formatting primitives.
3. Select Vitest minimal only in standalone mode.
4. Add the optional fd3 lifecycle protocol and failure-safe parser.
5. Add Calm rendering, static fallback, and authoritative final event.
6. Refine Live Trace agent labels and semantic color.
7. Test widths (40/80/120), color controls, concurrency, protocol corruption,
   Vitest failures, thresholds, signals, reporter modes, and packed execution.

## Non-goals for v1

- Worker-to-coordinator phase telemetry. Calm shows case name and elapsed time,
  not speculative phases such as "running agent" or "grading".
- Serializing evals for presentation.
- Parsing human Vitest output.
- A general rewrite of Pathgrade's project-local CLI formatting.
