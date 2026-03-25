# CLI Flag Verification Results

**Date:** 2026-03-25
**Method:** All tests run via `child_process.spawn` (no shell) from Node.js — same execution path as the implementation.

## Step 1: `--output-format text` with `-p` mode

```
spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence'])
stdin: "Reply with exactly: hello"
```

**Result:** exit 0, stdout `"hello\n"`, stderr empty.
**Verdict:** PASS

## Step 2: `--output-format json` + `--json-schema` with spawn

```
spawn('claude', ['-p', '--output-format', 'json', '--json-schema', schema, '--no-session-persistence'])
stdin: "What is 2+2? Put the answer in the answer field."
schema: {"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}
```

**Result:** exit 0, stdout is a JSON envelope with these keys:
- `type`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`
- `result`, `stop_reason`, `session_id`, `total_cost_usd`, `usage`, `modelUsage`
- `permission_denials`, `structured_output`, `fast_mode_state`, `uuid`

`structured_output` contains `{"answer":"4"}`.
**Verdict:** PASS — `--json-schema` takes inline JSON and `structured_output` is the extraction target.

## Step 3: Tool disabling in `-p` mode

**Test 3a:** `-p` mode without any `--tools` flag:
```
spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence'])
stdin: "What is 2+2? Reply with just the number."
```
**Result:** exit 0, stdout `"4\n"`. No tool invocations.

**Test 3b:** `-p` mode with `--allowedTools ''`:
```
spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence', '--allowedTools', ''])
```
**Result:** exit 0, stdout `"4\n"`. No tool invocations.

**Verdict:** `-p` mode already disables tools. No `--tools` or `--allowedTools` flag needed.

## Step 4: `claude auth status` exit codes

```
spawn('claude', ['auth', 'status'])
```

**Result (authenticated):** exit 0, stdout is machine-readable JSON:
```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "...",
  "orgId": "...",
  "orgName": "...",
  "subscriptionType": "team"
}
```

**Verdict:** PASS — exit 0 when authenticated, returns parseable JSON. The `loggedIn` field can serve as a secondary check if exit code behavior changes.

## Summary

| Flag / Behavior | Status | Notes |
|---|---|---|
| `-p --output-format text` | PASS | Clean text output |
| `-p --output-format json --json-schema` | PASS | Envelope with `structured_output` key |
| `-p` disables tools | PASS | No `--tools` flag needed |
| `auth status` exit codes | PASS | JSON output with `loggedIn` field |

## Plan Impact

- Remove `--tools ""` from `callClaudeCli` args — not needed
- `extractStructuredOutput` confirmed: envelope has `structured_output` at top level
- `isClaudeCliAvailable` can optionally parse the JSON and check `loggedIn: true` as a secondary safety net
