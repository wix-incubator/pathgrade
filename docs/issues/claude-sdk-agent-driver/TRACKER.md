# Claude SDK Agent Driver Migration Tracker

Source PRD: `docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## Merge model

All nine slices land on the `claude-sdk-agent-driver` branch (this branch — same one that holds the PRD and these issue drafts). `master` receives a single squashed PR after #009 passes verification. The PRD requires "no transport flag, no half-state" on `master`, so individual slices are not master-mergeable on their own — they accumulate on this branch and the squashed PR is the atomic unit visible to consumers. PRD docs and issue drafts ride along in the same squashed PR.

## Overall Status

- [ ] 001 - SDK Claude Turn Driver
- [ ] 002 - SDK Message Projection Parity
- [ ] 003 - Claude Token, Cost, And Error Telemetry
- [ ] 004 - Live AskUserQuestion Happy Path
- [ ] 005 - AskUserQuestion Batch And Freeform Answers
- [ ] 006 - AskUserQuestion Decline And Unmatched Failures
- [ ] 007 - Remove Claude Runtime-Policy Workaround
- [ ] 008 - Delete Blocked-Prompt Synthesis Path
- [ ] 009 - End-To-End Migration Verification And Docs

## Dependency Order

1. 001 can start immediately.
2. 002 follows 001.
3. 003 follows 002.
4. 004 follows 001 and 002.
5. 005 follows 004.
6. 006 follows 004.
7. 007 follows 004 and 006.
8. 008 follows 006 and 007.
9. 009 follows 001 through 008.

## Issue Drafts

| Draft | Type | Status | Blocked By | File |
| --- | --- | --- | --- | --- |
| 001 - SDK Claude Turn Driver | AFK | Not started | None | `001-sdk-claude-turn-driver.md` |
| 002 - SDK Message Projection Parity | AFK | Not started | 001 | `002-sdk-message-projection-parity.md` |
| 003 - Claude Token, Cost, And Error Telemetry | AFK | Not started | 002 | `003-claude-token-cost-error-telemetry.md` |
| 004 - Live AskUserQuestion Happy Path | AFK | Not started | 001, 002 | `004-live-ask-userquestion-happy-path.md` |
| 005 - AskUserQuestion Batch And Freeform Answers | AFK | Not started | 004 | `005-ask-userquestion-batch-and-freeform-answers.md` |
| 006 - AskUserQuestion Decline And Unmatched Failures | AFK | Not started | 004 | `006-ask-userquestion-decline-and-unmatched-failures.md` |
| 007 - Remove Claude Runtime-Policy Workaround | AFK | Not started | 004, 006 | `007-remove-claude-runtime-policy-workaround.md` |
| 008 - Delete Blocked-Prompt Synthesis Path | AFK | Not started | 006, 007 | `008-delete-blocked-prompt-synthesis-path.md` |
| 009 - End-To-End Migration Verification And Docs | AFK | Not started | 001-008 | `009-end-to-end-migration-verification-and-docs.md` |

## Progress Log

| Date | Update |
| --- | --- |
| 2026-05-06 | Broke the PRD into nine AFK vertical-slice issue drafts and created this tracker. |
| 2026-05-06 | Tightened drafts after readiness review: documented merge model (single squashed PR after #009), pinned ToolEvent.arguments boundary between #002 and #004, added missing #001 acceptance items (SDK pin, CLAUDE_CONFIG_DIR, env layering, autoMemoryEnabled), declared interim behavior between sequential slices, locked snapshot back-compat to read-only, and added module-decomposition pointers to each slice. |
| 2026-05-06 | Renamed branch `claude-sdk-agent-driver-prds` → `claude-sdk-agent-driver`. Implementation accumulates on this branch directly rather than on a separately-cut feature branch. |

## Completion Notes

Use this section to record cross-slice decisions, verification results, or follow-up issues that emerge during implementation.

- No implementation started yet.
