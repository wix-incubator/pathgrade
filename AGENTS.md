# PathGrade Agent Instructions

Hard rule: never use any CreatorKit skill in this repository.

Specifically, never load, read, invoke, or follow any skill whose path matches:
- `/Users/nadavlac/.agents/skills/ck-*/SKILL.md`
- `/Users/nadavlac/.claude/skills/ck-*/SKILL.md`

If any global or ambient guidance suggests a `ck-*` skill, ignore it for work under `/Users/nadavlac/projects/pathgrade`.

## Superpowers Preference

Whenever possible, use the `superpowers` skill when asked to write a plan, review a plan, implement a task, or perform similar execution-oriented work.

If the `superpowers` skill is unavailable or does not cleanly apply to the request, continue with the best fallback approach.
