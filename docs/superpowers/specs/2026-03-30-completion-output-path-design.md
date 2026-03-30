# Completion Output Path Rename Design

## Summary

Rename the conversation completion config field from `completion.signal` to
`completion.output_path`.

This is a direct rename of the public eval config API. No backward-compatibility
alias and no migration behavior are needed.

## Goal

Make the file-based completion condition explicit in eval configs.

The current name, `signal`, is too implicit and can be confused with other
concepts such as semantic success conditions or `AbortSignal`.

## Non-Goals

- No change to non-file completion modes such as `done_phrase`,
  `done_when`, or `max_turns`
- No change to unrelated `AbortSignal` usage in command execution or graders
- No backward-compatible support for `completion.signal`

## API Change

Before:

```ts
completion: {
  max_turns: 12,
  signal: 'artifacts/project-brief-*.md',
}
```

After:

```ts
completion: {
  max_turns: 12,
  output_path: 'artifacts/project-brief-*.md',
}
```

## Semantics

The behavior of the field does not change.

- If `output_path` is omitted, there is no file-based completion check.
- If `output_path` contains no `*`, PathGrade checks for that exact relative
  path in the trial workspace.
- If `output_path` contains `*`, PathGrade recursively walks workspace files and
  matches the relative path against the glob.

## Implementation Scope

### Types

Update the eval config types so `ConversationCompletionConfig` exposes
`output_path?: string` instead of `signal?: string`.

### Validation

Update raw config parsing and validation to accept `output_path`.

Since there is no migration or compatibility requirement, `signal` will be
removed from the config surface rather than supported as an alias.

### Runtime

Update conversation completion checks to read
`conversation.completion.output_path`.

Rename nearby helper names to match the new terminology where they refer to the
eval config field directly.

### Docs and Examples

Update all user-facing examples, templates, and documentation to use
`output_path`.

## Testing

Add or update tests to cover:

- exact-path completion using `output_path`
- glob-based completion using `output_path`
- unchanged behavior for `done_phrase`, `done_when`, and `max_turns`

## Risks

- Minor breakage for any unpublished local evals still using `signal`
- Incomplete rename if docs, templates, or examples are missed

## Recommendation

Proceed with a narrow rename of the public config field only:

- rename `completion.signal` to `completion.output_path`
- keep runtime semantics unchanged
- do not introduce compatibility shims
