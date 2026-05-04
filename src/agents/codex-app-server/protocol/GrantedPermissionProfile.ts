// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/GrantedPermissionProfile.ts
// GENERATED CODE in upstream; do not modify locally either.
//
// `AdditionalFileSystemPermissions` and `AdditionalNetworkPermissions` are modelled as
// opaque aliases until the driver needs to destructure them.

export type AdditionalFileSystemPermissions = unknown;
export type AdditionalNetworkPermissions = unknown;

export type GrantedPermissionProfile = {
    network?: AdditionalNetworkPermissions;
    fileSystem?: AdditionalFileSystemPermissions;
};
