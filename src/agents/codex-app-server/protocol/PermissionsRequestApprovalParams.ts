// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/PermissionsRequestApprovalParams.ts
// GENERATED CODE in upstream; do not modify locally either.
//
// `AbsolutePathBuf` and `RequestPermissionProfile` are opaque to the driver today.

export type AbsolutePathBuf = string;
export type RequestPermissionProfile = unknown;

export type PermissionsRequestApprovalParams = {
    threadId: string;
    turnId: string;
    itemId: string;
    cwd: AbsolutePathBuf;
    reason: string | null;
    permissions: RequestPermissionProfile;
};
