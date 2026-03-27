# Hybrid Tool Grader Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-agnostic, hybrid `tool_usage` grading capability by normalizing provider-specific tool traces into Pathgrade tool events and grading against those normalized events.

**Architecture:** Introduce a first-class `ToolEvent` model in trial logs, preserve enough per-turn trace data to extract events for all supported agents, then add a deterministic `tool_usage` grader that operates only on normalized Pathgrade actions. Roll the feature out in hybrid mode: best-effort provider extractors first, explicit capability boundaries in details/docs, and reporting support so failures are debuggable.

**Provider Support Matrix (MVP):**
| Agent | Extraction Support | Notes |
|-------|-------------------|-------|
| Codex | Best-effort | Requires empirical trace format validation before writing extractors |
| Gemini | Best-effort | Requires empirical trace format validation before writing extractors |
| Claude | **Unsupported in MVP** | `--output-format json` envelope only contains `result`, `session_id`, `is_error`, `permission_denials` — no tool call traces. Revisit if Claude CLI adds tool-trace output (e.g., `--verbose` or stream-json mode). |

**Tech Stack:** TypeScript, Node.js, vitest, fs-extra

---

## File Structure

**Create:**
- `src/tool-events.ts` — shared `ToolEvent` types, normalized action names, filtering helpers
- `src/tool-event-extractors.ts` — provider-specific trace parsers and normalization entry point
- `src/graders/tool-usage.ts` — deterministic grader for normalized tool events
- `tests/tool-events.test.ts` — extractor and matcher unit tests
- `examples/tool-usage/eval.ts` — end-to-end example using `tool_usage`
- `examples/tool-usage/README.md` — example walkthrough

**Modify:**
- `src/types.ts` — add tool event types, log entry variants, and trace payload support on agent turn results
- `src/agents/transcript-agent.ts` — default `traceOutput`
- `src/agents/codex.ts` — preserve tool-trace text for extraction
- `src/agents/gemini.ts` — preserve tool-trace text for extraction
- `src/agents/claude.ts` — preserve `traceOutput: rawOutput` (placeholder; Claude extraction unsupported in MVP)
- `src/evalRunner.ts` — instruction-mode tool event extraction and logging
- `src/conversationRunner.ts` — per-turn tool event extraction and logging
- `src/commands/run.ts` — pass `agentName` through eval options
- `src/core/config.types.ts` — add `tool_usage` grader config/input/resolved types
- `src/core/config.ts` — validate and resolve `tool_usage` config
- `src/core/define-eval.ts` — preserve `tool_usage` fields
- `src/graders/index.ts` — register new grader and add normalized tool-event transcript section for `llm_rubric`
- `src/reporters/cli.ts` — render tool grader output and tool-event counts
- `src/viewer.html` — render tool-event log entries and per-turn event summaries
- `src/pathgrade.ts` — update CLI help text for `--grader=tool_usage`
- `README.md` — document the new grader and hybrid support model
- `docs/grader-authoring.md` — document `tool_usage` authoring
- `tests/agents.test.ts` — verify `traceOutput` behavior
- `tests/config.test.ts` — validate `tool_usage` schema
- `tests/define-eval.test.ts` — validate `defineEval` support
- `tests/graders.test.ts` — unit test the new grader and `llm_rubric` transcript enrichment
- `tests/evalRunner.test.ts` — instruction-mode tool-event logging
- `tests/conversationRunner.test.ts` — per-turn tool-event logging
- `tests/reporters.cli.test.ts` — preview output for tool events / tool grader
- `tests/cli-surface-local-first.test.ts` — CLI/README surface expectations if needed

---

### Task 1: Add Tool Event Schema And Trace Plumbing

**Files:**
- Create: `src/tool-events.ts`
- Modify: `src/types.ts`
- Modify: `src/agents/transcript-agent.ts`
- Modify: `src/agents/codex.ts`
- Modify: `src/agents/gemini.ts`
- Modify: `src/agents/claude.ts`
- Modify: `src/commands/run.ts`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Write failing tests for preserved trace payloads**

> **Note:** The snippets below are illustrative — adapt to the existing test patterns in `tests/agents.test.ts` (which uses `agent.run()` and mock `CommandRunner`). Do not use `session.start()` directly as `AgentSession` may strip extra fields from `AgentTurnResult`.

In `tests/agents.test.ts`, add coverage that:

```typescript
it('exposes traceOutput for Codex and Gemini turns', async () => {
  // Use the existing mock CommandRunner pattern to capture AgentTurnResult
  const result = await agent.runTurn(/* ... */);
  expect(result.traceOutput).toContain('tool');
  expect(result.traceOutput).toBe(result.rawOutput);
});

it('sets traceOutput equal to rawOutput for Claude (MVP — no envelope extraction)', async () => {
  const result = await agent.runTurn(/* ... */);
  expect(result.traceOutput).toBe(result.rawOutput);
});
```

- [ ] **Step 2: Run the focused agent tests and verify they fail**

Run: `npx vitest run tests/agents.test.ts -t "traceOutput"`
Expected: FAIL because `AgentTurnResult` does not expose `traceOutput`

- [ ] **Step 3: Add shared tool-event and trace types**

In `src/tool-events.ts`, define the normalized event model:

```typescript
export type ToolAction =
  | 'run_shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_code'
  | 'list_files'
  | 'ask_user'
  | 'web_fetch'
  | 'unknown';

export interface ToolEvent {
  action: ToolAction;
  provider: 'claude' | 'codex' | 'gemini';
  providerToolName: string;
  turnNumber?: number;
  arguments?: Record<string, unknown>;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  rawSnippet: string;
}

export function summarizeToolEvents(events: ToolEvent[]): string {
  return events.map((event) => `${event.action}:${event.providerToolName}`).join(', ');
}
```

In `src/types.ts`, extend the runtime model:

```typescript
export interface AgentTurnResult {
  rawOutput: string;
  assistantMessage: string;
  exitCode: number;
  traceOutput?: string;
}

export interface ConversationTurn {
  // existing fields...
  tool_events?: ToolEvent[];
}

export interface LogEntry {
  type:
    | 'agent_start'
    | 'command'
    | 'agent_result'
    | 'grader'
    | 'reward'
    | 'user_reply'
    | 'step_grader'
    | 'tool_event';
  // existing fields...
  tool_event?: ToolEvent;
}
```

- [ ] **Step 4: Preserve trace output in each agent adapter**

Update `BaseAgent.createSession()` default in `src/types.ts` (~line 169-179) to include `traceOutput` so agents that don't override `createSession()` still produce it:

```typescript
// In the default AgentTurnResult construction inside BaseAgent.createSession():
return { rawOutput, assistantMessage: rawOutput, exitCode: 0, traceOutput: rawOutput };
```

Update `CodexAgent.runTurn()` in `src/agents/codex.ts` and `GeminiAgent.runTurn()` in `src/agents/gemini.ts` (NOT the abstract `TranscriptAgent` base class — `runTurn()` is abstract there):

```typescript
return {
  rawOutput,
  assistantMessage: rawOutput.trim(),
  exitCode: result.exitCode,
  traceOutput: rawOutput,
};
```

Update `src/agents/claude.ts` — set `traceOutput: rawOutput` for now. Claude's `--output-format json` envelope does NOT contain tool call traces (only `result`, `session_id`, `is_error`, `permission_denials`), so there is nothing useful to extract. Claude extraction is unsupported in MVP:

```typescript
return {
  rawOutput,
  assistantMessage: rawOutput.trim(),
  exitCode: result.exitCode,
  sessionId: parsed.extractedSessionId,
  traceOutput: rawOutput,
};
```

Update `src/commands/run.ts` — add `agentName` to `EvalRunOptions` AND **populate it** in the `evalOpts` construction (~line 136-155):

```typescript
// In EvalRunOptions type:
agentName: AgentName;

// In evalOpts construction (run.ts ~line 136-155):
const evalOpts: EvalRunOptions = {
  // ... existing fields ...
  agentName: agentName,  // <-- MUST be set here, not just on the type
};
```

Update `src/conversationRunner.ts` — add `agentName` to `ConversationRunOptions`:

```typescript
export interface ConversationRunOptions {
  // ... existing fields ...
  agentName: AgentName;
}
```

Update `src/evalRunner.ts` — pass `agentName` through when constructing conversation runner options (~line 188-198):

```typescript
const conversationOpts: ConversationRunOptions = {
  // ... existing fields ...
  agentName: opts.agentName,
};
```

- [ ] **Step 5: Run the focused agent suite and verify it passes**

Run: `npx vitest run tests/agents.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tool-events.ts src/types.ts src/agents/transcript-agent.ts src/agents/codex.ts src/agents/gemini.ts src/agents/claude.ts src/commands/run.ts tests/agents.test.ts
git commit -m "feat(tool-events): add trace payload support for agent turns"
```

---

### Task 2: Extract And Log Normalized Tool Events In Hybrid Mode

**Files:**
- Create: `src/tool-event-extractors.ts`
- Modify: `src/evalRunner.ts`
- Modify: `src/conversationRunner.ts`
- Modify: `src/types.ts`
- Test: `tests/tool-events.test.ts`
- Test: `tests/evalRunner.test.ts`
- Test: `tests/conversationRunner.test.ts`

- [ ] **Step 0 (PREREQUISITE): Capture real CLI trace output for each supported agent**

Before writing any extractors, run each supported agent CLI with tool-using tasks and capture the raw stdout/stderr output. Document the actual trace format in a comment or test fixture file:

```bash
# Codex: run a simple task and capture raw output
codex --approval-mode full-auto "list files in src/" 2>&1 | tee fixtures/codex-trace-sample.txt

# Gemini: same
gemini-cli "list files in src/" 2>&1 | tee fixtures/gemini-trace-sample.txt
```

The test fixtures in Step 1 below MUST use patterns from the real captured output, not invented format strings. If the real format differs from the examples below, update the tests accordingly.

- [ ] **Step 1: Write failing extractor and runner tests**

> **Note:** The trace format strings below (`tool: exec_command ...`) are illustrative placeholders. Replace with patterns from real CLI output captured in Step 0.

Create `tests/tool-events.test.ts` with representative trace snippets:

```typescript
import { extractToolEvents } from '../src/tool-event-extractors';

it('normalizes Codex shell and file-read traces', () => {
  // TODO: Replace with actual Codex CLI trace format from Step 0
  const trace = `
tool: exec_command {"cmd":"rg foo src"}
tool: localGetFileContent {"path":"src/app.ts"}
`;
  expect(extractToolEvents('codex', trace)).toEqual([
    expect.objectContaining({ action: 'run_shell', providerToolName: 'exec_command' }),
    expect.objectContaining({ action: 'read_file', providerToolName: 'localGetFileContent' }),
  ]);
});

it('returns empty array when no recognizable tool trace is present', () => {
  expect(extractToolEvents('codex', 'plain assistant text')).toEqual([]);
});

it('returns empty array for unsupported agent (claude MVP)', () => {
  expect(extractToolEvents('claude', 'any trace text')).toEqual([]);
});
```

Extend `tests/evalRunner.test.ts`:

```typescript
it('records normalized tool_event entries for instruction trials', async () => {
  const agent = makeMockSessionAgent({
    rawOutput: 'assistant text',
    assistantMessage: 'assistant text',
    traceOutput: 'tool: exec_command {"cmd":"npm test"}',
    exitCode: 0,
  });

  const report = await runner.runEval(() => agent, '/task', [], makeEvalOpts({ agentName: 'codex' }), 1);
  const toolEntries = report.trials[0].session_log.filter(entry => entry.type === 'tool_event');
  expect(toolEntries).toHaveLength(1);
  expect(toolEntries[0].tool_event?.action).toBe('run_shell');
});
```

Extend `tests/conversationRunner.test.ts`:

```typescript
it('attaches per-turn tool events in conversation runs', async () => {
  const responses = [{
    rawOutput: 'raw',
    assistantMessage: 'raw',
    traceOutput: 'tool: edit_file {"path":"src/app.ts"}',
    exitCode: 0,
  }];

  const result = await runConversationTrial({ ...opts, agentName: 'codex' });
  expect(result.conversation.turns[0].tool_events).toEqual([
    expect.objectContaining({ action: 'edit_file' }),
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/tool-events.test.ts tests/evalRunner.test.ts tests/conversationRunner.test.ts`
Expected: FAIL because extraction/logging does not exist yet

- [ ] **Step 3: Implement best-effort provider extractors**

In `src/tool-event-extractors.ts`, add a registry keyed by agent name:

```typescript
import { AgentName } from './core/config.types';
import { ToolEvent } from './tool-events';

export function extractToolEvents(agentName: AgentName, traceOutput: string, turnNumber?: number): ToolEvent[] {
  switch (agentName) {
    case 'codex':
      return extractCodexEvents(traceOutput, turnNumber);
    case 'gemini':
      return extractGeminiEvents(traceOutput, turnNumber);
    case 'claude':
      // Claude's --output-format json envelope does not contain tool traces.
      // Unsupported in MVP. Return empty.
      return [];
    default:
      return [];
  }
}
```

Implement conservative parsers that:
- only emit normalized events when the tool name and arguments are clearly recoverable
- preserve `providerToolName`, raw snippets, and confidence
- cap `rawSnippet` to 200 characters to avoid unbounded log growth
- return `[]` instead of guessing when the trace is ambiguous
- base all regex patterns on real CLI output captured in Step 0, not invented formats

- [ ] **Step 4: Extract tool events in both runner paths**

In `src/evalRunner.ts`, after the `agent_result` log entry is added:

```typescript
const traceOutput = turnResult.traceOutput || turnResult.rawOutput;
const toolEvents = extractToolEvents(opts.agentName, traceOutput, 1);
for (const toolEvent of toolEvents) {
  sessionLog.push({
    type: 'tool_event',
    timestamp: this.timestamp(),
    tool_event: toolEvent,
  });
}
```

In `src/conversationRunner.ts`:

First, update the local `turnResult` inline type declaration (~line 355) to include `traceOutput`. The current inline type `{ rawOutput: string; assistantMessage: string; exitCode: number }` silently strips `traceOutput` through type narrowing:

```typescript
// BEFORE (strips traceOutput):
let turnResult: { rawOutput: string; assistantMessage: string; exitCode: number } | undefined;

// AFTER (preserves traceOutput):
let turnResult: { rawOutput: string; assistantMessage: string; exitCode: number; traceOutput?: string } | undefined;
```

Then, after each completed turn:

```typescript
const traceOutput = turnResult.traceOutput || turnResult.rawOutput;
const toolEvents = extractToolEvents(opts.agentName, traceOutput, turnNumber);

if (toolEvents.length > 0) {
  turns[turns.length - 1].tool_events = toolEvents;
  for (const toolEvent of toolEvents) {
    sessionLog.push({
      type: 'tool_event',
      timestamp: opts.timestamp(),
      turn_number: turnNumber,
      tool_event: toolEvent,
    });
  }
}
```

- [ ] **Step 4b: Extend `sanitize()` to redact tool event fields**

In `src/evalRunner.ts`, update the `sanitize()` method (~line 385-429) to redact secrets from `tool_event` entries. `rawSnippet`, `summary`, and `arguments` may contain API keys, tokens, or credentials from shell commands:

```typescript
// Inside the sanitize() loop, add a case for tool_event entries:
if (entry.tool_event) {
  entry.tool_event.rawSnippet = redactSecrets(entry.tool_event.rawSnippet);
  entry.tool_event.summary = redactSecrets(entry.tool_event.summary);
  if (entry.tool_event.arguments) {
    for (const key of Object.keys(entry.tool_event.arguments)) {
      if (typeof entry.tool_event.arguments[key] === 'string') {
        entry.tool_event.arguments[key] = redactSecrets(entry.tool_event.arguments[key] as string);
      }
    }
  }
}
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `npx vitest run tests/tool-events.test.ts tests/evalRunner.test.ts tests/conversationRunner.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tool-event-extractors.ts src/evalRunner.ts src/conversationRunner.ts tests/tool-events.test.ts tests/evalRunner.test.ts tests/conversationRunner.test.ts
git commit -m "feat(tool-events): extract, log, and sanitize normalized tool events"
```

---

### Task 3: Add Declarative `tool_usage` Grader Support

**Files:**
- Create: `src/graders/tool-usage.ts`
- Modify: `src/core/config.types.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/define-eval.ts`
- Modify: `src/graders/index.ts`
- Test: `tests/config.test.ts`
- Test: `tests/define-eval.test.ts`
- Test: `tests/graders.test.ts`

- [ ] **Step 1: Write failing config and grader tests**

In `tests/config.test.ts`, add:

```typescript
it('accepts tool_usage graders with expectations', () => {
  const config = validateConfig({
    version: '1',
    tasks: [{
      name: 'tool-task',
      type: 'instruction',
      instruction: 'fix the bug',
      graders: [{
        type: 'tool_usage',
        weight: 1,
        expectations: [{ action: 'run_shell', min: 1 }],
      }],
    }],
  });

  expect(config.tasks[0].graders[0]).toEqual(
    expect.objectContaining({ type: 'tool_usage' })
  );
});
```

In `tests/graders.test.ts`, add:

```typescript
it('scores tool_usage expectations against normalized tool events', async () => {
  const grader = getGrader('tool_usage');
  const result = await grader.grade('/workspace', provider, {
    type: 'tool_usage',
    weight: 1,
    expectations: [
      { action: 'search_code', min: 1, weight: 0.4 },
      { action: 'read_file', min: 1, weight: 0.6 },
    ],
  }, '/task', [
    { type: 'tool_event', timestamp: 't1', tool_event: { action: 'search_code', provider: 'codex', providerToolName: 'localSearchCode', summary: 'search', confidence: 'high', rawSnippet: '...' } },
    { type: 'tool_event', timestamp: 't2', tool_event: { action: 'read_file', provider: 'codex', providerToolName: 'localGetFileContent', summary: 'read', confidence: 'high', rawSnippet: '...' } },
  ]);

  expect(result.score).toBe(1);
  expect(result.grader_type).toBe('tool_usage');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/config.test.ts tests/define-eval.test.ts tests/graders.test.ts`
Expected: FAIL because `tool_usage` is not a valid grader type yet

- [ ] **Step 3: Add `tool_usage` types and validation**

In `src/core/config.types.ts`, add:

```typescript
export interface ToolUsageExpectation {
  action: ToolAction;
  min?: number;
  max?: number;
  provider?: AgentName;
  path?: string;
  command_contains?: string;
  tool_name?: string;
  weight?: number;
}

export interface EvalToolUsageGraderConfig {
  type: 'tool_usage';
  expectations: ToolUsageExpectation[];
  weight: number;
}
```

Update the grader type discriminant union in **ALL** of these locations (7+ sites across 4 files):

1. `src/core/config.types.ts` — `EvalGraderConfig.type` (~line 75)
2. `src/core/config.types.ts` — `ResolvedGrader.type` (~line 161)
3. `src/core/config.types.ts` — `DefineEvalGraderInput.type` (~line 171)
4. `src/core/config.types.ts` — `RawGrader` type — add `expectations?: ToolUsageExpectation[]`
5. `src/types.ts` — `GraderConfig.type` (~line 41) — **CRITICAL: also add `expectations?: ToolUsageExpectation[]` to the runtime `GraderConfig` interface**, otherwise the grader receives no config
6. `src/types.ts` — `LogEntry.type` union (~line 76) — already handled in Task 1
7. `src/commands/run.ts` — `--grader` filter (~line 132-133)

> **Consider:** Creating a `VALID_GRADER_TYPES` const array (like the existing `VALID_AGENTS`) as a single source of truth for this union.

In `src/core/config.ts`:

Add a `tool_usage` branch to `resolveGrader()` (~line 304-318):

```typescript
if (g.type === 'tool_usage' && g.expectations) {
  return {
    type: 'tool_usage',
    expectations: g.expectations,
    weight: g.weight ?? 1,
  };
}
```

Validate that:
- `expectations` exists and is a non-empty array
- `action` is one of the supported normalized actions
- `min`/`max` are positive integers when provided
- `weight` defaults to `1.0` when omitted

Add a warning when `--grader` filter results in zero matching graders for a task (silent 0.0 scores are confusing).

- [ ] **Step 4: Implement the deterministic `tool_usage` grader**

Create `src/graders/tool-usage.ts`:

```typescript
import { Grader, GraderConfig, ToolUsageExpectation } from '../types';
import { ToolEvent } from '../tool-events';

function matchesExpectation(event: ToolEvent, expectation: ToolUsageExpectation): boolean {
  if (event.action !== expectation.action) return false;
  if (expectation.provider && event.provider !== expectation.provider) return false;
  if (expectation.tool_name && event.providerToolName !== expectation.tool_name) return false;
  if (expectation.path && event.arguments?.path !== expectation.path) return false;
  if (expectation.command_contains) {
    const cmd = String(event.arguments?.cmd || event.arguments?.command || '');
    if (!cmd.includes(expectation.command_contains)) return false;
  }
  return true;
}

export class ToolUsageGrader implements Grader {
  async grade(_workspace, _provider, config: GraderConfig, _taskPath, sessionLog) {
    const toolEvents = sessionLog
      .filter((entry) => entry.type === 'tool_event' && entry.tool_event)
      .map((entry) => entry.tool_event!);

    // Explicit empty-events guard per rollout notes: fail, don't silently pass
    if (toolEvents.length === 0) {
      return {
        grader_type: 'tool_usage',
        score: 0,
        weight: config.weight,
        details: `No tool events captured — extraction may have failed or agent used no tools`,
      };
    }

    const checks = (config.expectations || []).map((expectation) => {
      const matches = toolEvents.filter((event) => matchesExpectation(event, expectation));
      const passed = matches.length >= (expectation.min ?? 1)
        && (expectation.max === undefined || matches.length <= expectation.max);
      return {
        name: `${expectation.action}`,
        passed,
        message: `${matches.length} matching events`,
        weight: expectation.weight ?? 1,
      };
    });

    const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
    const earnedWeight = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
    const score = totalWeight === 0 ? 0 : earnedWeight / totalWeight;

    return {
      grader_type: 'tool_usage',
      score,
      weight: config.weight,
      details: `${earnedWeight}/${totalWeight} expectation weight passed`,
    };
  }
}
```

Register it in `src/graders/index.ts`:

```typescript
case 'tool_usage': return new ToolUsageGrader();
```

**CRITICAL:** Update the grader config assembly in `evalRunner.ts` `runGraders()` (~line 344-350) to forward `expectations` for `tool_usage` graders. The current code only cherry-picks `command`, `rubric`, `model`, `weight`:

```typescript
const graderConfig: GraderConfig = {
  type: graderDef.type,
  command: graderDef.type === 'deterministic' ? deterministicCommand(detIndex) : undefined,
  rubric: graderDef.type === 'llm_rubric' ? llmRubricPath(llmIndex) : undefined,
  expectations: graderDef.type === 'tool_usage' ? graderDef.expectations : undefined,  // <-- ADD THIS
  model: graderDef.model || opts.graderModel,
  weight: graderDef.weight,
};
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `npx vitest run tests/config.test.ts tests/define-eval.test.ts tests/graders.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/config.types.ts src/core/config.ts src/core/define-eval.ts src/graders/index.ts src/graders/tool-usage.ts tests/config.test.ts tests/define-eval.test.ts tests/graders.test.ts
git commit -m "feat(graders): add tool_usage grader"
```

---

### Task 4: Expose Tool Events In Rubrics And Reports

**Files:**
- Modify: `src/graders/index.ts`
- Modify: `src/reporters/cli.ts`
- Modify: `src/viewer.html`
- Test: `tests/graders.test.ts`
- Test: `tests/reporters.cli.test.ts`

- [ ] **Step 1: Write failing transcript/reporter tests**

In `tests/graders.test.ts`, add:

```typescript
it('includes normalized tool events in llm_rubric transcript context', async () => {
  // Mock rubric loading and LLM call as in existing tests.
  // Assert the prompt contains a "Tool Events" section with normalized actions.
});
```

In `tests/reporters.cli.test.ts`, add:

```typescript
it('prints tool_usage grader results and tool-event counts', async () => {
  const report = {
    task: 'tool-task',
    pass_rate: 1,
    pass_at_k: 1,
    pass_pow_k: 1,
    skills_used: [],
    trials: [{
      trial_id: 1,
      reward: 1,
      grader_results: [{ grader_type: 'tool_usage', score: 1, weight: 1, details: '2/2 expectation weight passed' }],
      duration_ms: 1000,
      n_commands: 1,
      input_tokens: 10,
      output_tokens: 20,
      session_log: [
        { type: 'tool_event', timestamp: 't', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...' } },
      ],
    }],
  };
  // Write JSON file, run preview, assert output contains tool_usage and tool_event
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/graders.test.ts tests/reporters.cli.test.ts`
Expected: FAIL because tool-event transcript/report rendering does not exist yet

- [ ] **Step 3: Add opt-in normalized tool-event transcript section for `llm_rubric`**

> **Important:** This enrichment MUST be opt-in to avoid silently changing scores for existing `llm_rubric` evals. Adding tool events unconditionally to every rubric prompt would be a breaking change to existing eval behavior.

In `src/core/config.types.ts`, add an opt-in field to the LLM rubric grader config:

```typescript
export interface EvalLLMRubricGraderConfig {
  // ... existing fields ...
  include_tool_events?: boolean;  // opt-in to include tool events in rubric transcript
}
```

In `src/graders/index.ts`, enrich the transcript builder **only when opted in**:

```typescript
if (config.include_tool_events) {
  const toolEvents = sessionLog
    .filter((entry) => entry.type === 'tool_event' && entry.tool_event)
    .map((entry) => entry.tool_event!);

  if (toolEvents.length > 0) {
    // Sanitize: only include action and provider tool name, not raw arguments
    // (arguments could contain adversarial content that manipulates the rubric judge)
    const lines = toolEvents.map((event) => {
      const turn = event.turnNumber ? `turn ${event.turnNumber}` : 'instruction';
      return `- ${turn}: ${event.action} via ${event.providerToolName} (${event.provider})`;
    });
    sections.push(`## Tool Events\n${lines.join('\n')}`);
  }
}
```

- [ ] **Step 4: Render tool events in CLI and browser preview**

In `src/reporters/cli.ts`, count and print `tool_event` entries:

```typescript
const toolEvents = (trial.session_log || []).filter(entry => entry.type === 'tool_event');
const toolSuffix = toolEvents.length ? `  ${fmt.dim(toolEvents.length + ' tool events')}` : '';
```

In `src/viewer.html`, add a `tool_event` case in `renderLogEntry` and show per-turn tool events:

```javascript
case 'tool_event':
  body = '<span class="badge badge-type">' + esc(e.tool_event?.action || 'unknown') + '</span> '
    + '<span class="grader-details">' + esc(e.tool_event?.summary || '') + '</span>';
  break;
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `npx vitest run tests/graders.test.ts tests/reporters.cli.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/graders/index.ts src/reporters/cli.ts src/viewer.html tests/graders.test.ts tests/reporters.cli.test.ts
git commit -m "feat(reporting): expose normalized tool events in reports"
```

---

### Task 5: Document Hybrid Support And Add An Example Eval

**Files:**
- Create: `examples/tool-usage/eval.ts`
- Create: `examples/tool-usage/README.md`
- Modify: `README.md`
- Modify: `docs/grader-authoring.md`
- Modify: `src/pathgrade.ts`
- Test: `tests/cli-surface-local-first.test.ts`

- [ ] **Step 1: Write failing documentation surface tests**

In `tests/cli-surface-local-first.test.ts`, add assertions that:

```typescript
it('documents tool_usage in README and CLI help', () => {
  expect(readme).toContain('tool_usage');
  expect(cliHelp).toContain('tool_usage');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/cli-surface-local-first.test.ts`
Expected: FAIL because the public surface does not mention `tool_usage`

- [ ] **Step 3: Document the hybrid rollout clearly**

Update `README.md`:
- add `tool_usage` to the grader list and examples
- state that support is hybrid/best-effort and depends on provider trace fidelity
- explain that normalized actions are the contract, not provider tool names

Update `docs/grader-authoring.md` with a new section:

```markdown
## Tool Usage Graders

`tool_usage` graders score normalized Pathgrade tool events rather than filesystem state.
They are best when you care about workflow requirements such as:
- search before editing
- run tests before finishing
- avoid asking the user unnecessarily
```

Update `src/pathgrade.ts` help text:

```typescript
--grader=TYPE      Run only graders of this type (deterministic|llm_rubric|tool_usage)
```

Create `examples/tool-usage/eval.ts` with a minimal expectation-based example:

```typescript
import { defineEval } from '@wix/pathgrade';

export default defineEval({
  tasks: [{
    name: 'tool-aware-fix',
    type: 'instruction',
    instruction: 'Inspect app.js, fix the failing test, and verify it.',
    workspace: ['fixtures/app.js'],
    graders: [
      {
        type: 'tool_usage',
        weight: 0.4,
        expectations: [
          { action: 'read_file', min: 1, weight: 0.3 },
          { action: 'edit_file', min: 1, weight: 0.3 },
          { action: 'run_shell', command_contains: 'test', min: 1, weight: 0.4 },
        ],
      },
      {
        type: 'deterministic',
        run: 'node graders/check.js',
        weight: 0.6,
      },
    ],
  }],
});
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npx vitest run tests/cli-surface-local-first.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add README.md docs/grader-authoring.md src/pathgrade.ts examples/tool-usage/eval.ts examples/tool-usage/README.md tests/cli-surface-local-first.test.ts
git commit -m "docs(tool-usage): document hybrid tool grader rollout"
```

---

## Rollout Notes

- The MVP should grade only normalized Pathgrade actions. Do not expose provider tool names in eval authoring as the primary contract.
- When extraction yields no events, `tool_usage` should fail with an explicit detail such as `No tool events captured — extraction may have failed or agent used no tools` rather than silently passing. This is implemented via the empty-events guard in `ToolUsageGrader`.
- Keep extractor logic conservative. False negatives are acceptable in the hybrid rollout; false positives are not.
- Do not refactor existing grader classes out of `src/graders/index.ts` unless the new code becomes unmanageable. The goal is the new capability, not a grader-framework rewrite.
- **Claude extraction is unsupported in MVP.** The `--output-format json` envelope only contains `result`, `session_id`, `is_error`, `permission_denials` — no tool call traces. The extractor returns `[]` for Claude. Revisit if Claude CLI adds tool-trace output modes.
- **Provider trace formats are not under our control.** Codex and Gemini CLI output formats can change between versions. Before writing extractors (Task 2, Step 0), capture real CLI output and base all regex patterns on it. Document the CLI versions patterns were validated against.
- **Sanitization is required.** `tool_event` fields (`rawSnippet`, `summary`, `arguments`) can contain secrets from agent shell commands. The `sanitize()` method must redact these before writing reports to disk.
- **LLM rubric enrichment is opt-in.** The `include_tool_events` flag on `llm_rubric` grader config gates whether tool events appear in rubric transcripts. This prevents silent score drift on existing evals.
- The `GraderConfig` type union must be updated in **7+ locations** across 4 files. See Task 3 Step 3 for the full enumeration. Consider creating a `VALID_GRADER_TYPES` const array as a single source of truth.
