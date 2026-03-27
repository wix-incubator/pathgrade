# Tool Usage Example

Demonstrates the `tool_usage` grader, which scores agent workflow by checking
which normalized tool actions the agent performed.

## What It Tests

The eval gives the agent a broken `app.js` and expects it to:

1. **Read** the file to understand the bug
2. **Edit** the file to fix it
3. **Run tests** to verify the fix

The `tool_usage` grader checks that these workflow steps actually happened,
while the `deterministic` grader verifies the fix is correct.

## Provider Support

Tool event extraction is best-effort:

| Agent | Support |
|-------|---------|
| Codex | Supported |
| Gemini | Supported |
| Claude | Unsupported in MVP |

When extraction yields no events, the grader returns score 0 with a diagnostic
message rather than silently passing.
