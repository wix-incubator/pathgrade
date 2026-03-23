# Grader Output Schema

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `score` | number | Float between 0.0 and 1.0. Required. |
| `details` | string | Human-readable summary of the result. Required. |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `checks` | array | Individual check results for granular reporting. |

### Check Object

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique identifier for the check. |
| `passed` | boolean | Whether the check passed. |
| `message` | string | Human-readable description of the result. |

## Full Example

```json
{
  "score": 0.67,
  "details": "2/3 checks passed",
  "checks": [
    {
      "name": "file-created",
      "passed": true,
      "message": "Output file exists"
    },
    {
      "name": "content-correct",
      "passed": false,
      "message": "Missing expected output"
    },
    {
      "name": "no-errors",
      "passed": true,
      "message": "No runtime errors"
    }
  ]
}
```

## Rules

1. The JSON must be the **only output on stdout**. Redirect all debug output to stderr.
2. The `score` must be between 0.0 and 1.0 inclusive.
3. If `checks` is provided, `score` should reflect the ratio of passed checks.
4. Exit code 0 indicates the grader ran successfully (even if the score is 0.0). Non-zero exit codes indicate grader failure.
