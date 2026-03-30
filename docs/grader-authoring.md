# Writing Deterministic Graders

Deterministic graders are scripts that evaluate an agent's work and report a score.
Any language works (Node, Python, Bash) — pathgrade extracts JSON from stdout.

## JSON Contract

Your grader script must print a JSON object to **stdout**:

```json
{
  "score": 0.8,
  "details": "4/5 checks passed",
  "checks": [
    { "name": "file-exists", "passed": true, "message": "Found output.txt" },
    { "name": "content-correct", "passed": true, "message": "Contains expected text" },
    { "name": "no-errors", "passed": true, "message": "No error output" },
    { "name": "format-valid", "passed": true, "message": "Valid JSON format" },
    { "name": "perf-ok", "passed": false, "message": "Took 12s, expected < 5s" }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `score` | `number` | Yes | Float between 0.0 and 1.0. Pathgrade clamps to this range. |
| `details` | `string` | No | Human-readable summary shown in reports. |
| `checks` | `array` | No | Per-check breakdown, rendered as checkmarks in CLI output. |

Each check object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Short identifier for the check. |
| `passed` | `boolean` | Yes | Whether this check passed. |
| `message` | `string` | No | Additional context about the result. |

### Important

- **Exit code is ignored** — only stdout JSON matters. Always exit 0.
- Pathgrade extracts the **first** `{...}` JSON object from stdout using regex.
- Anything printed before or after the JSON (debug output, etc.) is ignored.
- If no JSON is found in stdout, the score defaults to 0.

## TypeScript Type

For TypeScript graders, import the type for compile-time checking:

```ts
import type { GraderOutput } from 'pathgrade';

const result: GraderOutput = {
  score: 1.0,
  details: 'All checks passed',
  checks: [{ name: 'check-1', passed: true }],
};
console.log(JSON.stringify(result));
```

## Examples

### Bash

```bash
#!/bin/bash
passed=0
total=3

# Check 1: file exists
if [ -f output.txt ]; then
  passed=$((passed + 1))
  c1='{"name":"file-exists","passed":true,"message":"Found output.txt"}'
else
  c1='{"name":"file-exists","passed":false,"message":"output.txt not found"}'
fi

# Check 2: contains expected content
if grep -q "hello world" output.txt 2>/dev/null; then
  passed=$((passed + 1))
  c2='{"name":"content","passed":true,"message":"Contains hello world"}'
else
  c2='{"name":"content","passed":false,"message":"Missing hello world"}'
fi

# Check 3: no syntax errors
if node --check output.js 2>/dev/null; then
  passed=$((passed + 1))
  c3='{"name":"syntax","passed":true,"message":"Valid JS"}'
else
  c3='{"name":"syntax","passed":false,"message":"Syntax errors found"}'
fi

score=$(awk "BEGIN {printf \"%.2f\", $passed/$total}")
echo "{\"score\":$score,\"details\":\"$passed/$total checks passed\",\"checks\":[$c1,$c2,$c3]}"
```

### Node.js

```js
const fs = require('fs');

const checks = [];
let passed = 0;
const total = 2;

// Check 1
if (fs.existsSync('output.txt')) {
  checks.push({ name: 'file-exists', passed: true, message: 'Found output.txt' });
  passed++;
} else {
  checks.push({ name: 'file-exists', passed: false, message: 'output.txt not found' });
}

// Check 2
const content = fs.existsSync('output.txt') ? fs.readFileSync('output.txt', 'utf-8') : '';
if (content.includes('hello world')) {
  checks.push({ name: 'content', passed: true, message: 'Contains hello world' });
  passed++;
} else {
  checks.push({ name: 'content', passed: false, message: 'Missing hello world' });
}

console.log(JSON.stringify({
  score: passed / total,
  details: `${passed}/${total} checks passed`,
  checks,
}));
```

## Tool Usage Graders

`tool_usage` graders score normalized Pathgrade tool events rather than filesystem state.
They are best when you care about workflow requirements such as:
- search before editing
- run tests before finishing
- avoid asking the user unnecessarily

```typescript
{
  type: 'tool_usage',
  weight: 0.4,
  expectations: [
    { action: 'search_code', min: 1, weight: 0.2 },
    { action: 'read_file', min: 1, weight: 0.3 },
    { action: 'edit_file', min: 1, weight: 0.3 },
    { action: 'run_shell', command_contains: 'test', min: 1, weight: 0.2 },
  ],
}
```

### Expectations

| Field | Type | Description |
|-------|------|-------------|
| `action` | `ToolAction` | Normalized action: `run_shell`, `read_file`, `write_file`, `edit_file`, `search_code`, `list_files`, `ask_user`, `web_fetch` |
| `min` | `number` | Minimum matching events (default: 1) |
| `max` | `number` | Maximum matching events (optional) |
| `weight` | `number` | Weight within the expectation set (default: 1) |
| `command_contains` | `string` | For `run_shell`: substring match on the command |
| `argument_pattern` | `string` | Regex tested against all string values in the tool's arguments |
| `path` | `string` | Match on the file path argument |
| `tool_name` | `string` | Match on the provider-specific tool name |

### Provider Support

| Agent | Support | Notes |
|-------|---------|-------|
| Codex | Best-effort | Extracts from CLI stdout trace |
| Gemini | Best-effort | Extracts from CLI stdout trace |
| Claude | Unsupported (MVP) | `--output-format json` does not expose tool traces |

When no tool events are captured, the grader returns score 0 with an explicit message rather than silently passing.

### Python

```python
import json, os

checks = []
passed = 0
total = 2

if os.path.exists('output.txt'):
    checks.append({"name": "file-exists", "passed": True, "message": "Found output.txt"})
    passed += 1
else:
    checks.append({"name": "file-exists", "passed": False, "message": "output.txt not found"})

content = open('output.txt').read() if os.path.exists('output.txt') else ''
if 'hello world' in content:
    checks.append({"name": "content", "passed": True, "message": "Contains hello world"})
    passed += 1
else:
    checks.append({"name": "content", "passed": False, "message": "Missing hello world"})

print(json.dumps({
    "score": passed / total,
    "details": f"{passed}/{total} checks passed",
    "checks": checks,
}))
```
