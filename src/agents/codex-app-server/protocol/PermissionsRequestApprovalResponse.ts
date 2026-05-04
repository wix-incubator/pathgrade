// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/PermissionsRequestApprovalResponse.ts
// GENERATED CODE in upstream; do not modify locally either.

import type { GrantedPermissionProfile } from './GrantedPermissionProfile.js';

/**
 * Scope for a granted permission — `'turn'` auto-grants within the current
 * turn only; `'thread'` persists until the thread ends. Upstream union is
 * represented as a string literal set here.
 */
export type PermissionGrantScope = 'turn' | 'thread';

export type PermissionsRequestApprovalResponse = {
    permissions: GrantedPermissionProfile;
    scope: PermissionGrantScope;
    /**
     * Review every subsequent command in this turn before normal sandboxed execution.
     */
    strictAutoReview?: boolean;
};
