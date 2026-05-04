// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolCallParams.ts
// GENERATED CODE in upstream; do not modify locally either.

export type JsonValue = unknown;

export type DynamicToolCallParams = {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string | null;
    tool: string;
    arguments: JsonValue;
};
