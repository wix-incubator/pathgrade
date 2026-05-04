# Vendored `codex-app-server` protocol types

The `.ts` files in this directory are vendored verbatim from
[`openai/codex`](https://github.com/openai/codex) at tag
`rust-v0.124.0`. Most files live upstream under
`codex-rs/app-server-protocol/schema/typescript/v2/`. A handful of top-level
upstream files carry the union/handshake shapes and live directly at
`codex-rs/app-server-protocol/schema/typescript/` (no `v2/` segment):
`ClientRequest.ts`, `ServerRequest.ts`, `InitializeParams.ts`, `ClientInfo.ts`,
`InitializeCapabilities.ts`.

Three files here are pathgrade-local compositions that don't exist upstream
as single files:

- `ClientRequest.ts` — method-name union for client→server JSON-RPC requests
  (aggregated from the top-level upstream `typescript/ClientRequest.ts`).
- `ServerRequest.ts` — discriminated union over the 9 server-request variants
  (aggregated from the top-level upstream `typescript/ServerRequest.ts`).
- `Op.ts` — the `UserInputAnswer` op shape the driver writes.

Each vendored file carries an upstream-citation header comment. Verbatim
files retain their upstream `// GENERATED CODE!` marker so the origin is
obvious.

## Refreshing on an upstream version bump

1. Bump the tag in every `// Vendored from openai/codex@...` header.
2. Re-copy each file's body from the correct upstream directory:
   - top-level files (`ClientRequest`, `ServerRequest`, `InitializeParams`,
     `ClientInfo`, `InitializeCapabilities`) from
     `codex-rs/app-server-protocol/schema/typescript/<Filename>.ts`.
   - everything else from
     `codex-rs/app-server-protocol/schema/typescript/v2/<Filename>.ts`.
3. Replace any `unknown` alias with the vendored shape if the driver now
   destructures it.
4. Run the protocol fixture suite
   (`PATHGRADE_RUN_PROTOCOL_FIXTURES=1 npx vitest run tests/codex-app-server`)
   to catch wire-format drift.

## Runtime consumption

Pathgrade does not depend on the `@openai/codex` npm package at build or run
time; the driver spawns the PATH-installed `codex` binary and talks JSON-RPC
over stdio, using these vendored types for compile-time shape checking. The
protocol tag above is the single source of truth for protocol alignment.
