# sdk-regression

Regression eval that exercises every public SDK surface across all three agents
(`claude`, `codex`, `cursor`). Run this to confirm nothing is broken end-to-end
after SDK changes.

Run one agent:

    npx vitest run --config examples/sdk-regression/vitest.config.mts \
      examples/sdk-regression/test/sdk-regression-codex.eval.ts

Run the whole suite (all three agents + offline surface smoke):

    npx vitest run --config examples/sdk-regression/vitest.config.mts

Features covered (see `test/shared.ts` for the coverage matrix).
