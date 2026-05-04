// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts
// GENERATED CODE in upstream; do not modify locally either.
//
// NOTE: upstream imports additional shared types (Personality, ServiceTier, JsonValue,
// ApprovalsReviewer, AskForApproval, PermissionProfile, ThreadStartSource) that are not
// required by the pathgrade Codex driver. They are modelled here as opaque aliases so the
// vendored surface compiles standalone. Refresh policy: when a new upstream version lands,
// replace each alias with the vendored definition if the driver starts consuming it.

import type { SandboxMode } from './SandboxMode.js';

// Opaque aliases — shapes the driver does not yet destructure.
export type Personality = unknown;
export type ServiceTier = unknown;
export type JsonValue = unknown;
export type ApprovalsReviewer = unknown;
export type AskForApproval = unknown;
export type PermissionProfile = unknown;
export type ThreadStartSource = unknown;

export type ThreadStartParams = {
    model?: string | null;
    modelProvider?: string | null;
    serviceTier?: ServiceTier | null | null;
    cwd?: string | null;
    approvalPolicy?: AskForApproval | null;
    /**
     * Override where approval requests are routed for review on this thread
     * and subsequent turns.
     */
    approvalsReviewer?: ApprovalsReviewer | null;
    sandbox?: SandboxMode | null;
    /**
     * Full permissions override for this thread. Cannot be combined with
     * `sandbox`.
     */
    permissionProfile?: PermissionProfile | null;
    config?: { [key: string]: JsonValue | undefined } | null;
    serviceName?: string | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    personality?: Personality | null;
    ephemeral?: boolean | null;
    sessionStartSource?: ThreadStartSource | null;
    /**
     * If true, opt into emitting raw Responses API items on the event stream.
     * This is for internal use only (e.g. Codex Cloud).
     */
    experimentalRawEvents: boolean;
    /**
     * If true, persist additional rollout EventMsg variants required to
     * reconstruct a richer thread history on resume/fork/read.
     */
    persistExtendedHistory: boolean;
};
