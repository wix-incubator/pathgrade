# Standalone release evidence

Copy this file for each release candidate. Replace every `PENDING` value with independently verified evidence from the same source commit and retained tarball. **Any pending field blocks human approval and publication.** A source-tree build or a differently packed tarball is not substitute evidence.

## Release identity

| Evidence | Status | Verified value or link |
|---|---|---|
| Source commit | PENDING | PENDING |
| Release tag | PENDING | PENDING |
| Scoped package/version (`@wix/pathgrade`) | PENDING | PENDING |
| Retained tarball path/artifact ID | PENDING | PENDING |
| Canonical tarball SHA-512 | PENDING | PENDING |
| npm integrity | PENDING | PENDING |
| Canonical file list | PENDING | PENDING |
| Unpacked size | PENDING | PENDING |
| Installed-size comparison | PENDING | PENDING |

## Exact runtime provenance

| Runtime | Required value | Status | Evidence |
|---|---|---|---|
| Node | 22/24 as applicable | PENDING | PENDING |
| Vitest | 4.1.7 | PENDING | PENDING |
| Claude Agent SDK | 0.2.116 | PENDING | PENDING |
| Embedded Claude Code | 2.1.116 | PENDING | PENDING |
| Codex package/native | 0.144.0 / 0.144.0 | PENDING | PENDING |

## Protected live records

| Required record | Status | Evidence link |
|---|---|---|
| Linux Claude, retained digest, zero selected-provider skips | PENDING | PENDING |
| Linux Codex app-server, retained digest, zero selected-provider skips | PENDING | PENDING |
| macOS Codex app-server, retained digest, zero selected-provider skips | PENDING | PENDING |

## Platform records

| Tuple ID | Status | Evidence link |
|---|---|---|
| `darwin-arm64-node24` | PENDING | PENDING |
| `darwin-x64-node24` | PENDING | PENDING |
| `linux-arm64-node24` | PENDING | PENDING |
| `linux-x64-node24` | PENDING | PENDING |
| `wsl-x64-node24` (manual protected evidence) | PENDING | PENDING |
| Five-record validator result | PENDING | PENDING |

## Trusted staging and immutable artifact checks

| Evidence | Status | Verified value or link |
|---|---|---|
| Trusted publisher organization (`wix-incubator`) | PENDING | PENDING |
| Trusted publisher repository (`pathgrade`) | PENDING | PENDING |
| Workflow filename (`publish.yml`) | PENDING | PENDING |
| Protected environment (`npm-publish`) | PENDING | PENDING |
| Allowed action (`npm stage publish`) | PENDING | PENDING |
| Pre-stage artifact state (`absent`, `matching`, or `conflict`) | PENDING | PENDING |
| Stage ID, or matching-public no-op record | PENDING | PENDING |
| Downloaded staged tarball path and SHA-512 | PENDING | PENDING |
| Downloaded staged standalone smoke | PENDING | PENDING |
| Provenance/attestation verification | PENDING | PENDING |
| Final artifact-state classification | PENDING | PENDING |

## Approval

- Human 2FA approver: PENDING
- Approval timestamp: PENDING
- All fields above verified with no pending values: PENDING

Publication is blocked unless the final line is verified `yes` and every field above is verified against the same commit and retained tarball.
