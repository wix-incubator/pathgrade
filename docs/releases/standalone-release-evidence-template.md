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
| WSL runtime discriminator (`kind=wsl`, Microsoft/WSL kernel, observed `WSL_INTEROP`) | PENDING | PENDING |
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
| Actual Sigstore bundle (`pathgrade-provenance-verification/v2`) | PENDING | PENDING |
| Pinned local `sigstore@4.0.0` verification result (Fulcio + CT + Rekor) | PENDING | PENDING |
| SLSA v1 subject SHA-512 equals downloaded tarball | PENDING | PENDING |
| Attested repository is exactly `wix-incubator/pathgrade` | PENDING | PENDING |
| Attested workflow is exactly `.github/workflows/publish.yml` | PENDING | PENDING |
| Attested source commit equals release commit | PENDING | PENDING |
| Final artifact-state classification | PENDING | PENDING |

The trusted-publishing OIDC token is valid for `npm stage publish` only. It must not be used or described as authorization for `npm stage list`, `npm stage view`, or `npm stage download`. After the workflow submits a stage, it intentionally stops.

An authorized human must use a separate, short-lived interactive npm session outside the OIDC job to list/view/download the staged artifact, obtain its actual npm Sigstore bundle, and run the standalone smoke against the downloaded bytes without rebuilding or repacking. Upload these results as a `pathgrade-staged-verification/v1` record plus the exact downloaded tarball; its provenance field must be a `pathgrade-provenance-verification/v2` record containing the bundle, not a caller-authored success assertion. The follow-up workflow uses the repository-pinned Sigstore implementation to verify the signature, Fulcio certificate identity and chain, certificate-transparency requirement, and Rekor inclusion before it reads the signed DSSE statement. It then validates that statement against the retained SHA-512, source commit, package metadata, exact repository/workflow/tag, and smoke result. Missing or incomplete external evidence blocks approval.

## Approval

- Human 2FA approver: PENDING
- Approval timestamp: PENDING
- All fields above verified with no pending values: PENDING

Publication is blocked unless the final line is verified `yes` and every field above is verified against the same commit and retained tarball.
