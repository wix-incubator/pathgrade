## Parent PRD

`docs/prds/2026-05-05-claude-sdk-agent-driver.md`

## What to build

Extend the live Claude ask-user bridge beyond the single-question happy path to support batches, independent reaction matching for each question, multi-select answers, and free-text answers. Existing `whenAsked` predicates should continue to evaluate against the Pathgrade-local structured question shape.

Extends the **ask-user-bridge** module from #004 per PRD §Module decomposition. No new module.

Type: AFK

## Acceptance criteria

- [ ] A single `AskUserQuestion` call with multiple questions emits one live batch containing every question.
- [ ] Each question in a batch is matched independently against `whenAsked` predicates and can receive a different answer.
- [ ] Multi-select answers are returned in the SDK's comma-separated answer string contract. Tests assert that all selected option labels are present in the answer string but **do not** pin a specific separator format (e.g. literal `", "` vs `","`); the SDK comment states "comma-separated" without specifying the separator format, and the bridge follows whatever the bundled binary expects.
- [ ] Free-text answers supplied by reactions are returned through the same `answers` map as option answers.
- [ ] `whenAsked` predicates see the same structured fields they see today: question text, header, options, and multi-select-derived shape.
- [ ] Tests cover multi-question batches, different answers per question, multi-select answers, free-text answers, and predicate compatibility.

## Blocked by

- Blocked by local draft #004 (Live AskUserQuestion Happy Path)

## User stories addressed

- User story 6
- User story 7
- User story 28
