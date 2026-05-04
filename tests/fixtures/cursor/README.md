# Cursor stream-json fixtures

Recorded against `cursor-agent` CLI — intended version `2026.04.17-787b533`
(see `PRD_CURSOR_AGENT_DRIVER.md`).

These fixtures are **hand-crafted** at slice #03 landing. They mirror the
Claude stream-json envelope shape observed in the discovery spikes:

- `type: "system"`, `subtype: "init"` — session bootstrap (source of `session_id`
  for diagnostic purposes; the authoritative source is the `result` event).
- `type: "tool_call"`, `subtype: "started"` / `"completed"` — one per tool use.
- `type: "assistant"` — assistant text chunks.
- `type: "interaction_query"` — approval round-trips from `--force` / `--approve-mcps`.
- `type: "result"` — terminal envelope with `is_error`, `session_id`, `result`, `usage`.

The `usage` shape assumed here matches Claude's exactly:
`{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`.
If a real `cursor-agent` recording reveals different field names, the parser
and these fixtures are the place to remap or widen.

## Version header

Every committed fixture starts with a one-line comment:

```
// cursor-agent version: 2026.04.17-787b533
```

The comment is JSON-unparseable, so `parseCursorStreamJson` and
`extractCursorStreamJsonEvents` silently skip it. The pinned version lives
in `scripts/record-cursor-fixtures.ts` as `CURSOR_PINNED_CLI_VERSION`.

## Refreshing the fixtures

When Cursor reshapes its stream-json, re-record all fixtures in one shot:

```
pnpm tsx scripts/record-cursor-fixtures.ts
```

The script invokes a locally-installed `cursor-agent` with per-discriminant
prompts and rewrites each file with a fresh version header. A `cursor-agent
login` session must already exist (or `CURSOR_API_KEY` must be set). CI does
not run the recorder — the drift check in `cursor-fixture-recorder.test.ts`
warns on mismatch but never fails, and skips cleanly when the binary is
absent.
