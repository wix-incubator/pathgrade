# Vendored `codex-app-server` protocol types

The `.ts` files in this directory are a curated Pathgrade protocol surface
based on [`openai/codex`](https://github.com/openai/codex) at tag
`rust-v0.144.0`. Most vendored shapes live upstream under
`codex-rs/app-server-protocol/schema/typescript/v2/`. The union files
`ClientRequest.ts` and `ServerRequest.ts` live upstream directly under
`codex-rs/app-server-protocol/schema/typescript/` (no `v2/` segment), but
Pathgrade keeps local compositions for the subset this driver sends or
observes.

Three files here are pathgrade-local compositions that don't exist upstream
as single files:

- `ClientRequest.ts` — method-name union for client→server JSON-RPC requests
  (aggregated from the top-level upstream `typescript/ClientRequest.ts`).
- `ServerRequest.ts` — discriminated union over the 9 server-request variants
  (aggregated from the top-level upstream `typescript/ServerRequest.ts`).
- `Op.ts` — the `UserInputAnswer` op shape the driver writes.

Each vendored or locally composed file carries an upstream-citation or
composition header. Files with `// GENERATED CODE in upstream` started from
upstream generated types, though some contain opaque aliases where Pathgrade
does not currently inspect the nested shape.

## Refreshing on an upstream version bump

1. Bump the tag in every `// Vendored from openai/codex@...` header.
2. Re-copy each vendored file's body from the correct upstream directory:
   - local union compositions (`ClientRequest`, `ServerRequest`) should be
     checked against the top-level upstream files at
     `codex-rs/app-server-protocol/schema/typescript/<Filename>.ts`.
   - everything else should be checked against
     `codex-rs/app-server-protocol/schema/typescript/v2/<Filename>.ts`.
3. Replace any `unknown` alias with the vendored shape if the driver now
   destructures it.
4. Run the protocol fixture suite
   (`PATHGRADE_RUN_PROTOCOL_FIXTURES=1 npx vitest run tests/codex-app-server`)
   to catch wire-format drift.

## Runtime consumption

Pathgrade's standalone runtime depends on the pinned `@openai/codex` npm
package and invokes its JavaScript launcher through Node. Project-local mode
continues to spawn the PATH-installed `codex` binary. Both modes talk JSON-RPC
over stdio using these vendored types for compile-time shape checking.
