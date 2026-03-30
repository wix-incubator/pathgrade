# Grader Descriptor Refactor

**Date:** 2026-03-27
**Status:** Approved
**Branch:** `refactor/cleanup`

## Problem

Eval files currently define graders as plain config objects with `run: 'node graders/check-fix.js'`. This leaks the execution mechanism (shell commands, Node.js) into the eval configuration. Grader logic lives in standalone JS scripts that print JSON to stdout, creating an awkward boundary between the eval file and its grading logic.

## Solution

Replace raw grader config objects with first-class **grader descriptor objects** created by factory functions. Deterministic graders provide an `execute` function with pure TypeScript logic. The eval file no longer knows or cares about shell execution.

## Public API

### Factory Functions

Three factory functions exported from `pathgrade`:

```ts
import { defineEval, deterministicGrader, llmRubricGrader, toolUsageGrader } from 'pathgrade';
```

#### `deterministicGrader(opts)`

User provides the grading logic as a TypeScript function.

```ts
function deterministicGrader(opts: {
  weight?: number;  // defaults to 1.0
  execute: (ctx: GraderContext) => Promise<GraderOutput>;
}): GraderDescriptor;
```

#### `llmRubricGrader(opts)`

User provides rubric text or file path. System handles transcript building, LLM calls, response parsing.

```ts
function llmRubricGrader(opts: {
  weight?: number;  // defaults to 1.0
  rubric: string;   // inline text or file path (resolved relative to eval.ts)
  model?: string;   // e.g. 'gemini-2.0-flash', 'claude-sonnet-4-20250514'
  include_tool_events?: boolean;
}): GraderDescriptor;
```

#### `toolUsageGrader(opts)`

Declarative expectations against normalized tool events.

```ts
function toolUsageGrader(opts: {
  weight?: number;  // defaults to 1.0
  expectations: ToolUsageExpectation[];
}): GraderDescriptor;
```

### GraderContext

Shared execution context passed to every `execute` function:

```ts
interface GraderContext {
  /** Absolute path to the trial workspace */
  workspacePath: string;
  /** Run a shell command in the workspace */
  runCommand: (cmd: string) => Promise<CommandResult>;
  /** Full session log (commands, tool events, agent output, etc.) */
  sessionLog: LogEntry[];
  /** Environment variables */
  env: Record<string, string>;
  /** Abort signal for timeout handling */
  signal?: AbortSignal;
}
```

### GraderDescriptor

Plain object returned by all factory functions. Validated by checking required fields per type (e.g., `deterministic` requires `execute`, `llm_rubric` requires `rubric`, `tool_usage` requires `expectations`):

```ts
interface GraderDescriptor {
  type: GraderType;
  weight: number;
  // Deterministic
  execute?: (ctx: GraderContext) => Promise<GraderOutput>;
  // LLM rubric
  rubric?: string;
  model?: string;
  include_tool_events?: boolean;
  // Tool usage
  expectations?: ToolUsageExpectation[];
}
```

### GraderOutput (unchanged)

```ts
interface GraderOutput {
  score: number;          // 0.0-1.0
  details?: string;
  checks?: GraderCheck[];
}
```

## Eval File Usage

Grader logic lives in TypeScript files under `graders/`, exported as descriptors:

```ts
// graders/check-fix.ts
import { deterministicGrader } from 'pathgrade';
import * as fs from 'fs-extra';
import * as path from 'path';

export const checkFix = deterministicGrader({
  weight: 0.6,
  execute: async ({ workspacePath }) => {
    const content = await fs.readFile(path.join(workspacePath, 'app.js'), 'utf-8');
    const hasFix = content.includes('a + b');
    return {
      score: hasFix ? 1 : 0,
      details: hasFix ? 'Fix applied' : 'Bug still present',
    };
  },
});
```

Eval files import and compose graders:

```ts
// ck-new.eval.ts
import { defineEval, llmRubricGrader } from 'pathgrade';
import { checkFix } from './graders/check-fix';
import { checkBrief } from './graders/check-brief';

export default defineEval({
  tasks: [{
    name: 'tool-aware-fix',
    type: 'instruction',
    instruction: 'Fix the bug in app.js',
    workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
    graders: [
      checkFix,
      llmRubricGrader({ rubric: 'Evaluate the fix quality...', weight: 0.4 }),
    ],
  }],
});
```

## Internal Pipeline Changes

### Config Types (`config.types.ts`)

- Remove `EvalGraderConfig`, `DefineEvalGraderInput`, `ResolvedGrader` interfaces
- Replace with `GraderDescriptor` throughout
- Task interfaces (`EvalTaskBase`, `DefineEvalTaskBase`, `ResolvedTaskBase`) use `graders: GraderDescriptor[]`
- `StepGraderConfig` and `ResolvedStepGrader` also use `GraderDescriptor[]`

### Config Validation (`config.ts`)

- **Critical: pass descriptors through untouched.** The current `validateConfig()` reconstructs grader objects field-by-field, which silently strips the `execute` function. After this refactor, `validateConfig()` must detect `GraderDescriptor` objects (by checking `typeof g.type === 'string'` and presence of type-specific fields) and pass them through without reconstruction.
- Validate required fields per type: `deterministic` needs `execute` (function), `llm_rubric` needs `rubric` (string), `tool_usage` needs `expectations` (array). Throw clear error messages on mismatch.
- `resolveGrader()` simplifies: returns a shallow copy of the descriptor with `rubric` resolved via `resolveFileOrInline(descriptor.rubric, baseDir)` for `llm_rubric` types. The original descriptor is not mutated — this is important because the same descriptor may be shared across multiple tasks. Deterministic graders need no resolution (logic is in `execute`) — `resolveGrader` returns them as-is (or a shallow copy for consistency).
- `resolveFileOrInline()` remains for rubric and instruction resolution

### Define Eval (`define-eval.ts`)

- Passes `GraderDescriptor` objects through directly — no field-by-field mapping. The current code maps `g => ({ type: g.type, run: g.run, ... })` which drops `execute`. After this refactor, graders pass through as-is.

### Temp Dir Staging (`commands/run.ts`)

`prepareTempTaskDir()` changes — explicitly:

**Remove:**
- Deterministic script writing (lines 262-269): the loop that writes `#!/bin/bash` scripts to `.pathgrade/tests/` — no longer needed since deterministic graders use `execute`.
- Deterministic directory-copy heuristic (lines 273-286): the loop that scans `g.run` for file path patterns and copies referenced directories — dead code with `execute` functions.
- Step deterministic script writing: the loop that writes `turn_N_idx.sh` files to `.pathgrade/tests/steps/`.

**Keep:**
- LLM rubric writing (lines 289-295): writes `.pathgrade/prompts/*.md` files.
- Step LLM rubric writing: writes `turn_N_idx.md` files to `.pathgrade/prompts/steps/`.
- Workspace file staging (lines 322-337): copies workspace mappings.
- The `.pathgrade/tests/` directory creation can be removed; `.pathgrade/prompts/` stays.

### Eval Runner (`evalRunner.ts`)

- `runGraders()` no longer calls `getGrader(type)` to instantiate classes
- For deterministic graders: builds `GraderContext` and calls `descriptor.execute(ctx)` directly, clamps score to [0, 1]. The `execute` call is wrapped in try/catch — if it throws, score is 0 with the error message in details.
- For `llm_rubric`: instantiates `LLMGrader` internally, same as before but sourced from descriptor fields. `include_tool_events` is threaded through: `graderConfig.include_tool_events = descriptor.include_tool_events`.
- For `tool_usage`: instantiates `ToolUsageGrader` internally, same as before

**GraderContext construction** — built inside `runGraders()` from existing provider/runtime:

```ts
const ctx: GraderContext = {
  workspacePath: getWorkspacePath(runtime),
  runCommand: (cmd: string) => provider.runCommand(runtime, cmd, env, { signal }),
  sessionLog,
  env: env ?? {},
  signal,
};
```

The `runCommand` closure captures `runtime`, `env`, and `signal` from the grader execution scope so execute functions get a simple `(cmd) => Promise<CommandResult>` API.

### Conversation Runner (`conversationRunner.ts`)

`runStepGraders()` follows the same dispatch pattern as `runGraders()`:

- For deterministic step graders: builds `GraderContext` with the same closure construction as above (using `opts.runtime`, `opts.provider`, `opts.env`), calls `descriptor.execute(ctx)`. The `sessionLog` passed is the full log up to the current turn — same as today.
- For `llm_rubric` step graders: uses `stepLlmRubricPath(turnNumber, graderIndex)` to locate the staged rubric file — this path helper is kept. Threads `include_tool_events`.
- For `tool_usage` step graders: same as main graders.
- `stepDeterministicCommand()` is removed — no longer needed since deterministic graders call `execute` directly instead of running a shell script.

### Grader Implementations (`graders/index.ts`)

- `DeterministicGrader` class removed (logic lives in user's `execute` function)
- `LLMGrader` class stays as internal implementation
- `getGrader()` factory removed
- `Grader` interface stays for `LLMGrader` and `ToolUsageGrader` internal use

### Grader Implementations (`graders/tool-usage.ts`)

- `ToolUsageGrader` class stays as internal implementation, unchanged

### Grader Paths (`graders/paths.ts`)

- Remove `deterministicScriptName()`, `deterministicCommand()`, `stepDeterministicCommand()`
- Keep `llmRubricName()`, `llmRubricPath()`, `stepLlmRubricPath()` and directory constants

### Public Exports (`core/index.ts`)

- Add exports: `deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`
- Add type exports: `GraderDescriptor`, `GraderContext`
- Remove type exports: `EvalGraderConfig`, `DefineEvalGraderInput`, `ResolvedGrader`

## Migration

All 7 eval files and their grader scripts are migrated:

| Eval File | Grader Scripts | Migration |
|-----------|---------------|-----------|
| `pathgrade.eval.ts` | `graders/check-eval-ts.js` | Rewrite as `graders/check-eval-ts.ts` exporting a `GraderDescriptor`. **Note:** regexes in check-eval-ts.js match `'deterministic'` and `'llm_rubric'` string literals — update task instruction and grader regexes to match new API patterns (`deterministicGrader(`, `llmRubricGrader(`). |
| `pathgrade.eval.ts` task 2 | Inline 15-line bash script | **High complexity.** This task tests the agent's ability to write a deterministic grader script (bash). The refactor makes that workflow obsolete. Rewrite task 2 to test the new `deterministicGrader({ execute })` authoring workflow instead — the agent should produce a `.ts` grader file that exports a descriptor. |
| `examples/ck-new/ck-new.eval.ts` | `graders/check-fix.js`, `graders/check-brief.js` | Rewrite as `.ts`, export descriptors |
| `examples/tool-usage/tool-usage.eval.ts` | No `graders/` directory exists — `run: 'node graders/check.js'` references a file that was never created | Create `graders/check.ts` from scratch implementing the check logic, wrap `tool_usage` in `toolUsageGrader()` |
| `examples/angular-modern/angular-modern.eval.ts` | `graders/check-modern-apis.js` | Rewrite as `.ts`, export descriptor |
| `examples/ck-product-strategy/ck-product-strategy.eval.ts` | `graders/check-strategy.js` | Rewrite as `.ts`, export descriptor |
| `examples/superlint/superlint.eval.ts` | Inline bash script, inline LLM rubric | Rewrite bash as `graders/check-lint.ts`, wrap rubric in `llmRubricGrader()` |
| `examples/typescript-example/typescript-example.eval.ts` | Inline bash deterministic grader | Rewrite as `graders/check-output.ts` exporting descriptor, wrap inline logic in `execute` |

For each existing `.js` grader script:
1. Read the existing `.js` file to understand the check logic
2. Create a `.ts` file in the same `graders/` directory
3. Export a `GraderDescriptor` using `deterministicGrader({ execute: ... })`
4. Port the JSON-to-stdout logic into the `execute` function returning `GraderOutput`
5. Delete the old `.js` file
6. Update the eval file to import the new descriptor

For inline bash graders (superlint, typescript-example): extract into a new `graders/*.ts` file.

For `tool-usage/graders/check.js` (does not exist): create from scratch based on the eval task's intent.

LLM rubric and tool_usage graders are straightforward: replace `{ type: 'llm_rubric', rubric: '...', weight: 0.3 }` with `llmRubricGrader({ rubric: '...', weight: 0.3 })`.

## Tests

Update `tests/graders.test.ts`:

**Remove:** All 13 `DeterministicGrader` class tests (the class no longer exists).

**Add:**
- Factory tests: `deterministicGrader()` returns correct `type` and default `weight: 1.0`; `llmRubricGrader()` and `toolUsageGrader()` likewise.
- Execute invocation: `runGraders()` calls `descriptor.execute(ctx)` and returns the result as a `GraderResult` with correct `grader_type`, `score`, `weight`.
- Score clamping: `runGraders()` clamps `execute` return values to [0, 1] (scores > 1 become 1, scores < 0 become 0).
- Execute error handling: if `execute` throws, grader result has `score: 0` and `details` contains the error message.
- `runCommand` delegation: `GraderContext.runCommand('ls')` calls `provider.runCommand(runtime, 'ls', env, { signal })`.
- Signal propagation: `GraderContext.signal` is the same `AbortSignal` from the timeout wrapper.
- Config validation: missing `execute` on `deterministic` type throws; missing `rubric` on `llm_rubric` throws; missing `expectations` on `tool_usage` throws.

**Keep:** All `LLMGrader` and `ToolUsageGrader` tests stay unchanged.

## Breaking Changes

This is a breaking change to the `defineEval()` public API:

- **Removed types:** `EvalGraderConfig`, `DefineEvalGraderInput`, `ResolvedGrader` — replaced by `GraderDescriptor`.
- **Removed field:** `setup?: string` on grader config — was already inert (logged a "not yet implemented" warning). Intentionally dropped.
- **New required exports:** `deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`, `GraderDescriptor`, `GraderContext`.
- **Versioning:** This is currently pre-1.0 with no external consumers outside this repo. No semver bump needed. If external consumers exist before implementation, bump major version.

## Security Considerations

`execute` functions are trusted in-process code. Unlike the previous shell-based graders that ran as subprocesses, `execute` has full access to the Node.js process: `process.env`, filesystem, `process.exit()`, etc. This is a deliberate DX trade-off — grader authors are the same people writing the eval files, so this is equivalent trust.

Mitigations:
- `execute` calls are wrapped in try/catch so a throwing grader doesn't crash the eval runner.
- The existing timeout/abort mechanism applies: `signal` is passed through `GraderContext` and the `withAbortTimeout` wrapper in `runGraders()` still enforces the grader timeout.
- `execute` functions should be stateless. The same descriptor may be called across parallel trials with different `GraderContext` values. Mutable state in closures is a user error.

### Internal `GraderConfig` in `types.ts`

The `GraderConfig` interface is used internally by `LLMGrader.grade()` and `ToolUsageGrader.grade()`. Remove the `command?: string` field (was only for `DeterministicGrader`). The remaining fields (`type`, `rubric`, `model`, `weight`, `expectations`, `include_tool_events`) are still needed by the internal grader classes.

## What Stays Unchanged

- `GraderOutput`, `GraderCheck`, `GraderResult` types
- `LogEntry`, `ToolUsageExpectation` types
- `LLMGrader` internal implementation (transcript building, LLM API calls, response parsing)
- `ToolUsageGrader` internal implementation (expectation matching)
- `CommandResult` type
- Eval runner timeout/abort handling
- Score clamping and weighted average calculation
