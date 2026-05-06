# Claude SDK Agent Driver Migration Tracker

Source PRD: `docs/prds/2026-05-05-claude-sdk-agent-driver.md`

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

## Completion Notes

Use this section to record cross-slice decisions, verification results, or follow-up issues that emerge during implementation.

- No implementation started yet.
