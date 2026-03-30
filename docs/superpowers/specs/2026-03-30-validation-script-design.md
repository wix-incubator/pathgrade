# Validation Script Rename Design

## Summary

Rename the task field from `solution` to `validation_script`.

This is a hard rename of the public eval config API. No backward-compatible
alias is needed.

## Goal

Make the field name match its actual behavior.

The current name, `solution`, is ambiguous and sounds like the task's answer or
expected output. In practice, the field is a path to a script that PathGrade
runs only in `--validate` mode to verify graders against a known-correct
workspace state.

## Non-Goals

- No change to how `--validate` works
- No change to the fact that validation mode currently supports instruction
  tasks only
- No change to unrelated uses of the English word "solution" in examples,
  grader rubrics, or product content
- No backward-compatible support for `solution`

## API Change

Before:

```ts
{
  name: 'fix-the-bug',
  type: 'instruction',
  instruction: '...',
  solution: 'solve-fix.sh',
  graders: [/* ... */],
}
```

After:

```ts
{
  name: 'fix-the-bug',
  type: 'instruction',
  instruction: '...',
  validation_script: 'solve-fix.sh',
  graders: [/* ... */],
}
```

## Semantics

Behavior does not change.

- `validation_script` is optional
- It is used only by `pathgrade --validate`
- PathGrade resolves it relative to the eval file directory
- PathGrade runs it with `bash` inside the task workspace
- It remains unsupported for conversation-task validation because
  `--validate` still rejects conversation tasks

## Implementation Scope

### Types

Replace `solution?: string` with `validation_script?: string` in:

- task config types
- resolved task types
- `defineEval` task input types

### Config Pipeline

Update validation and resolution so the config pipeline accepts
`validation_script` and resolves it to an absolute path.

Remove `solution` from the public config surface.

### Validation Mode

Update the `--validate` code path so it:

- requires `validation_script`
- reports missing-field errors using `validation_script`
- executes the resolved `validation_script`

### Docs and Templates

Update all user-facing docs, templates, and examples that describe this field or
the `--validate` workflow.

Keep unrelated product/domain references to the word "solution" unchanged.

## Testing

Add or update tests to cover:

- config parsing with `validation_script`
- path resolution for `validation_script`
- validation-mode errors when `validation_script` is missing
- validation-mode execution using `validation_script`

## Risks

- Minor breakage for any unpublished local evals still using `solution`
- Incomplete rename if help text, docs, or examples are missed

## Recommendation

Proceed with a full public rename from `solution` to `validation_script` while
keeping runtime behavior unchanged.
