# `eval.ts` Specification

## Top-Level Keys

```typescript
import { defineEval } from '@wix/pathgrade';

export default defineEval({
  // skill: 'path/to/my-skill',  // Optional, defaults to auto-detecting SKILL.md
  defaults: { ... },
  tasks: [ ... ],
});
```

## `defaults`

Shared settings for all tasks.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `agent` | string | auto-detect | `gemini`, `claude`, or `codex` |
| `trials` | number | 5 | Number of evaluation trials |
| `timeout` | number | 300 | Seconds before the agent timeout |
| `threshold` | number | 0.8 | Pass-rate threshold for `--ci` mode |
| `grader_model` | string | auto-detect | Default LLM model for rubric graders |

### `defaults.environment`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `cpus` | number | 2 | CPU limit for each local trial |
| `memory_mb` | number | 2048 | Memory limit in megabytes |

## `tasks`

Array of evaluation tasks.

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | string | Yes | Unique task identifier |
| `instruction` | string | Yes | What the agent should accomplish. Supports file references. |
| `workspace` | array | No | Files copied into the trial workspace |
| `graders` | array | Yes | One or more grader definitions |
| `agent` | string | No | Per-task agent override |
| `trials` | number | No | Per-task trial count override |
| `timeout` | number | No | Per-task timeout override |
| `environment` | object | No | Per-task environment limit overrides |

### `workspace` entries

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `src` | string | Yes | Source path relative to the skill directory |
| `dest` | string | Yes | Destination path inside the trial workspace |
| `chmod` | string | No | File permissions such as `"+x"` |

### `grader` entries

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `type` | string | Yes | `deterministic` or `llm_rubric` |
| `run` | string | Deterministic only | Command or file reference to execute |
| `setup` | string | No | Optional grader dependency install step |
| `rubric` | string | LLM only | Evaluation rubric text or file reference |
| `model` | string | No | LLM model override |
| `weight` | number | No | Grader weight, default `1` |

## File References

`instruction`, `rubric`, and `run` can point at files. If the value resolves to a real path, Pathgrade reads the file contents automatically.

```typescript
instruction: 'instructions/fix-linting.md',
rubric: 'rubrics/workflow-quality.md',
run: 'graders/check.sh',
```

## Deprecated Fields

Pathgrade now runs locally only. Do not use:

- `defaults.provider`
- `defaults.docker`
- `tasks[].provider`
- `tasks[].docker`
