// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/McpServerElicitationRequestParams.ts
// GENERATED CODE in upstream; do not modify locally either.
//
// Filename localized to `McpElicitationRequestParams.ts` (spec §What to build).
// `JsonValue` and `McpElicitationSchema` are opaque aliases — v1 declines elicitations
// rather than interpreting them (decisions §7).

export type JsonValue = unknown;
export type McpElicitationSchema = unknown;

export type McpElicitationRequestParams = {
    threadId: string;
    /**
     * Active Codex turn when this elicitation was observed, if app-server could
     * correlate one. Nullable because MCP models elicitation as a standalone
     * server-to-client request identified by the MCP server request id.
     */
    turnId: string | null;
    serverName: string;
} & (
    | { mode: 'form'; _meta: JsonValue | null; message: string; requestedSchema: McpElicitationSchema }
    | { mode: 'url'; _meta: JsonValue | null; message: string; url: string; elicitationId: string }
);
