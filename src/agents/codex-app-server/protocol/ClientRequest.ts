// Pathgrade-local composition; not a single upstream file.
// Upstream ships the discriminated union at
// `codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts`
// (top-level, NOT `typescript/v2/`). This module enumerates the subset of
// method names the pathgrade Codex app-server driver actually sends. Refresh
// from openai/codex@rust-v0.124.0 when bumping the vendored version.

/**
 * The 8 client-request methods the pathgrade driver may send to the Codex
 * app-server. Scoped to this driver's surface rather than the full upstream
 * protocol; phantom response-shaped entries are deliberately excluded because
 * JSON-RPC responses to server-initiated requests flow through
 * `transport.sendResponse(req.id, …)`, not through this union.
 *
 * - initialize
 * - thread/start
 * - turn/start
 * - turn/interrupt
 * - thread/inject_items
 * - thread/read
 * - thread/list
 * - review/start
 */
export type ClientRequestMethod =
    | 'initialize'
    | 'thread/start'
    | 'turn/start'
    | 'turn/interrupt'
    | 'thread/inject_items'
    | 'thread/read'
    | 'thread/list'
    | 'review/start';

/**
 * JSON-RPC 2.0 client→server request envelope the driver constructs.
 * Generic over the params type for the chosen method.
 */
export interface ClientRequest<TParams> {
    jsonrpc: '2.0';
    id: number | string;
    method: ClientRequestMethod;
    params: TParams;
}
