# Grader Descriptor Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace raw grader config objects with first-class GraderDescriptor objects created by factory functions, so eval files use `deterministicGrader({ execute })` instead of `{ type: 'deterministic', run: 'node ...' }`.

**Architecture:** Three factory functions (`deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`) return `GraderDescriptor` plain objects. The eval runner dispatches on `descriptor.type`: deterministic calls `descriptor.execute(ctx)` in-process, while LLM rubric and tool_usage delegate to existing internal grader classes. Config validation passes descriptors through untouched (no field-by-field reconstruction).

**Tech Stack:** TypeScript, Vitest, fs-extra

**Spec:** `docs/superpowers/specs/2026-03-27-grader-descriptor-refactor-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/core/grader-factories.ts` | Factory functions + `GraderDescriptor` / `GraderContext` types |
| Modify | `src/core/config.types.ts` | Remove old grader types, use `GraderDescriptor` |
| Modify | `src/core/config.ts` | Pass descriptors through validation, simplify `resolveGrader` |
| Modify | `src/core/define-eval.ts` | Pass graders through as-is |
| Modify | `src/core/index.ts` | Export factories + new types |
| Modify | `src/types.ts` | Remove `command` from `GraderConfig` |
| Modify | `src/graders/index.ts` | Remove `DeterministicGrader`, `getGrader` |
| Modify | `src/graders/paths.ts` | Remove deterministic path helpers |
| Modify | `src/evalRunner.ts` | New `runGraders` dispatch with `GraderContext` |
| Modify | `src/conversationRunner.ts` | New `runStepGraders` dispatch |
| Modify | `src/commands/run.ts` | Simplify `prepareTempTaskDir` |
| Modify | `tests/graders.test.ts` | Replace DeterministicGrader tests with factory/execute tests |
| Create | `graders/check-eval-ts.ts` | Migrated from `graders/check-eval-ts.js` |
| Delete | `graders/check-eval-ts.js` | Replaced by `.ts` |
| Modify | `pathgrade.eval.ts` | Use factory imports |
| Create | `examples/ck-new/graders/check-fix.ts` | Migrated from `.js` |
| Create | `examples/ck-new/graders/check-brief.ts` | Migrated from `.js` |
| Delete | `examples/ck-new/graders/check-fix.js` | Replaced by `.ts` |
| Delete | `examples/ck-new/graders/check-brief.js` | Replaced by `.ts` |
| Modify | `examples/ck-new/ck-new.eval.ts` | Use factory imports |
| Create | `examples/tool-usage/graders/check.ts` | New (did not exist before) |
| Modify | `examples/tool-usage/tool-usage.eval.ts` | Use factory imports |
| Create | `examples/angular-modern/graders/check-modern-apis.ts` | Migrated from `.js` |
| Delete | `examples/angular-modern/graders/check-modern-apis.js` | Replaced by `.ts` |
| Modify | `examples/angular-modern/angular-modern.eval.ts` | Use factory imports |
| Create | `examples/ck-product-strategy/graders/check-strategy.ts` | Migrated from `.js` |
| Delete | `examples/ck-product-strategy/graders/check-strategy.js` | Replaced by `.ts` |
| Modify | `examples/ck-product-strategy/ck-product-strategy.eval.ts` | Use factory imports |
| Create | `examples/superlint/graders/check-lint.ts` | Extracted from inline bash |
| Modify | `examples/superlint/superlint.eval.ts` | Use factory imports |
| Create | `examples/typescript-example/graders/check-output.ts` | Extracted from inline bash |
| Modify | `examples/typescript-example/typescript-example.eval.ts` | Use factory imports |

---

### Task 1: Create GraderDescriptor types and factory functions

**Files:**
- Create: `src/core/grader-factories.ts`
- Test: `tests/graders.test.ts` (add factory tests at top)

- [x] **Step 1: Write factory tests**

Add to the top of `tests/graders.test.ts`:

```ts
import { deterministicGrader, llmRubricGrader, toolUsageGrader } from '../src/core/grader-factories';

describe('grader factories', () => {
  it('deterministicGrader returns correct type and default weight', () => {
    const g = deterministicGrader({
      execute: async () => ({ score: 1 }),
    });
    expect(g.type).toBe('deterministic');
    expect(g.weight).toBe(1.0);
    expect(typeof g.execute).toBe('function');
  });

  it('deterministicGrader respects explicit weight', () => {
    const g = deterministicGrader({
      weight: 0.5,
      execute: async () => ({ score: 1 }),
    });
    expect(g.weight).toBe(0.5);
  });

  it('llmRubricGrader returns correct type with rubric', () => {
    const g = llmRubricGrader({ rubric: 'Evaluate quality' });
    expect(g.type).toBe('llm_rubric');
    expect(g.weight).toBe(1.0);
    expect(g.rubric).toBe('Evaluate quality');
  });

  it('llmRubricGrader passes model and include_tool_events', () => {
    const g = llmRubricGrader({
      rubric: 'test',
      model: 'gemini-2.0-flash',
      include_tool_events: true,
      weight: 0.3,
    });
    expect(g.model).toBe('gemini-2.0-flash');
    expect(g.include_tool_events).toBe(true);
    expect(g.weight).toBe(0.3);
  });

  it('toolUsageGrader returns correct type with expectations', () => {
    const expectations = [{ action: 'read_file' as const, min: 1 }];
    const g = toolUsageGrader({ expectations, weight: 0.4 });
    expect(g.type).toBe('tool_usage');
    expect(g.weight).toBe(0.4);
    expect(g.expectations).toBe(expectations);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/graders.test.ts`
Expected: FAIL — `grader-factories` module not found

- [x] **Step 3: Create grader-factories.ts**

Create `src/core/grader-factories.ts`:

```ts
import type { GraderOutput, GraderCheck, CommandResult, LogEntry } from '../types';
import type { ToolUsageExpectation, GraderType } from './config.types';

export interface GraderContext {
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

export interface GraderDescriptor {
    type: GraderType;
    weight: number;
    /** Deterministic: user-provided grading logic */
    execute?: (ctx: GraderContext) => Promise<GraderOutput>;
    /** LLM rubric: inline text or file path */
    rubric?: string;
    /** LLM rubric: model override */
    model?: string;
    /** LLM rubric: include tool events in transcript */
    include_tool_events?: boolean;
    /** Tool usage: declarative expectations */
    expectations?: ToolUsageExpectation[];
}

export function deterministicGrader(opts: {
    weight?: number;
    execute: (ctx: GraderContext) => Promise<GraderOutput>;
}): GraderDescriptor {
    return {
        type: 'deterministic',
        weight: opts.weight ?? 1.0,
        execute: opts.execute,
    };
}

export function llmRubricGrader(opts: {
    weight?: number;
    rubric: string;
    model?: string;
    include_tool_events?: boolean;
}): GraderDescriptor {
    return {
        type: 'llm_rubric',
        weight: opts.weight ?? 1.0,
        rubric: opts.rubric,
        model: opts.model,
        include_tool_events: opts.include_tool_events,
    };
}

export function toolUsageGrader(opts: {
    weight?: number;
    expectations: ToolUsageExpectation[];
}): GraderDescriptor {
    return {
        type: 'tool_usage',
        weight: opts.weight ?? 1.0,
        expectations: opts.expectations,
    };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graders.test.ts`
Expected: All factory tests PASS

- [x] **Step 5: Commit**

```bash
git add src/core/grader-factories.ts tests/graders.test.ts
git commit -m "feat: add GraderDescriptor types and factory functions"
```

---

### Task 2: Update config types to use GraderDescriptor

**Files:**
- Modify: `src/core/config.types.ts`
- Modify: `src/core/index.ts`

- [x] **Step 1: Replace grader types in config.types.ts**

In `src/core/config.types.ts`, remove these interfaces:
- `EvalGraderConfig` (lines 91-99)
- `DefineEvalGraderInput` (lines 189-197)
- `ResolvedGrader` (lines 178-186)

Import and re-export `GraderDescriptor` from `grader-factories.ts`. Replace all usages:

Replace the `EvalGraderConfig` interface and imports:

```ts
// Add at top of file, after existing imports
export type { GraderDescriptor, GraderContext } from './grader-factories';
import type { GraderDescriptor } from './grader-factories';
```

Change `EvalTaskBase.graders` type:
```ts
// Before:
graders: EvalGraderConfig[];
// After:
graders: GraderDescriptor[];
```

Change `DefineEvalTaskBase.graders` type:
```ts
// Before:
graders: DefineEvalGraderInput[];
// After:
graders: GraderDescriptor[];
```

Change `ResolvedTaskBase.graders` type:
```ts
// Before:
graders: ResolvedGrader[];
// After:
graders: GraderDescriptor[];
```

Change `StepGraderConfig.graders` type:
```ts
// Before:
graders: EvalGraderConfig[];
// After:
graders: GraderDescriptor[];
```

Change `ResolvedStepGrader.graders` type:
```ts
// Before:
graders: ResolvedGrader[];
// After:
graders: GraderDescriptor[];
```

Keep `VALID_GRADER_TYPES` and `GraderType` in `config.types.ts` — `grader-factories.ts` imports from it. Just remove the old interfaces (`EvalGraderConfig`, `DefineEvalGraderInput`, `ResolvedGrader`).

- [x] **Step 2: Update public exports in core/index.ts**

In `src/core/index.ts`, replace:

```ts
export { defineEval } from './define-eval';
export { loadEvalConfig, resolveTask } from './config';
export { deterministicGrader, llmRubricGrader, toolUsageGrader } from './grader-factories';
export type {
    AgentName,
    TaskMode,
    DefineEvalInput,
    DefineEvalTaskInput,
    GraderDescriptor,
    GraderContext,
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    WorkspaceMapping,
    EnvironmentConfig,
    ConversationConfig,
    ConversationReplyConfig,
    ConversationPersonaConfig,
    ConversationCompletionConfig,
} from './config.types';
export type { GraderOutput, GraderCheck } from '../types';
```

Removed: `DefineEvalGraderInput`, `EvalGraderConfig`, `ResolvedGrader`.
Added: `deterministicGrader`, `llmRubricGrader`, `toolUsageGrader`, `GraderDescriptor`, `GraderContext`.

- [x] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Type errors in config.ts, define-eval.ts, evalRunner.ts, conversationRunner.ts, commands/run.ts (these files still reference old types — expected, will fix in subsequent tasks)

- [x] **Step 4: Commit**

```bash
git add src/core/config.types.ts src/core/index.ts
git commit -m "refactor: replace EvalGraderConfig/ResolvedGrader with GraderDescriptor"
```

---

### Task 3: Update config validation and resolution

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/define-eval.ts`

- [x] **Step 1: Update validateConfig grader handling in config.ts**

In `src/core/config.ts`, update the imports at the top:

```ts
import {
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    ResolvedTask,
    WorkspaceMapping,
    EnvironmentConfig,
    AgentName,
    VALID_AGENTS,
} from './config.types';
import type { GraderDescriptor } from './grader-factories';
import { DEFAULT_CONFIG } from './defaults';
```

Replace the grader mapping block inside `validateConfig` (the `graders: (t.graders || []).map(...)` section, around lines 247-260) with pass-through validation:

```ts
            const graders: GraderDescriptor[] = (t.graders || []).map((g: any, gIdx: number) => {
                if (!g || typeof g !== 'object') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] must be an object`);
                }
                if (!g.type || typeof g.type !== 'string') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] must have a "type" field`);
                }
                if (g.type === 'deterministic' && typeof g.execute !== 'function') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (deterministic) must have an "execute" function`);
                }
                if (g.type === 'llm_rubric' && typeof g.rubric !== 'string') {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (llm_rubric) must have a "rubric" string`);
                }
                if (g.type === 'tool_usage' && !Array.isArray(g.expectations)) {
                    throw new Error(`Task "${t.name}" graders[${gIdx}] (tool_usage) must have an "expectations" array`);
                }
                // Pass descriptor through untouched — do NOT reconstruct field-by-field
                // (reconstructing would strip the execute function)
                return g as GraderDescriptor;
            });
```

Do the same for the step_graders mapping (around lines 290-305):

```ts
                    graders: (sg.graders || []).map((g: any, gIdx: number) => {
                        if (!g || typeof g !== 'object') {
                            throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] must be an object`);
                        }
                        if (g.type === 'deterministic' && typeof g.execute !== 'function') {
                            throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (deterministic) must have an "execute" function`);
                        }
                        if (g.type === 'llm_rubric' && typeof g.rubric !== 'string') {
                            throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (llm_rubric) must have a "rubric" string`);
                        }
                        if (g.type === 'tool_usage' && !Array.isArray(g.expectations)) {
                            throw new Error(`Task "${t.name}" step_graders[${sgIdx}].graders[${gIdx}] (tool_usage) must have an "expectations" array`);
                        }
                        return g as GraderDescriptor;
                    }),
```

Remove the `RawGrader` interface (lines 81-89) — no longer needed. Also change `RawTask.graders` and `RawStepGrader.graders` to `any[]` since they no longer reference `RawGrader`:

```ts
// In RawTask interface:
graders?: any[];

// In RawStepGrader interface:
graders?: any[];
```

Also update `resolveTask()` (around line 366) — change the `ResolvedGrader[]` annotation:

```ts
// Before:
const graders: ResolvedGrader[] = await Promise.all(
// After:
const graders: GraderDescriptor[] = await Promise.all(
```

And update the `resolveTask` import to include `GraderDescriptor`:

```ts
import type { GraderDescriptor } from './grader-factories';
```

(This import was already added in Step 1 for validateConfig — just verify it's there.)

- [x] **Step 2: Simplify resolveGrader in config.ts**

Replace the `resolveGrader` function (around lines 320-337):

```ts
async function resolveGrader(g: GraderDescriptor, baseDir: string): Promise<GraderDescriptor> {
    if (g.type === 'llm_rubric' && g.rubric) {
        return { ...g, rubric: await resolveFileOrInline(g.rubric, baseDir) };
    }
    // Deterministic and tool_usage descriptors pass through as-is
    return { ...g };
}
```

- [x] **Step 3: Update define-eval.ts to pass graders through**

Replace `src/core/define-eval.ts`:

```ts
import { EvalConfig, DefineEvalInput } from './config.types';
import { validateConfig } from './config';

/**
 * Define a pathgrade evaluation config in TypeScript.
 * All defaults are optional — same defaults as EvalConfig.
 */
export function defineEval(input: DefineEvalInput): EvalConfig {
    const raw: Record<string, unknown> = {
        version: input.version || '1',
        skillPath: input.skillPath,
        defaults: input.defaults ? {
            ...input.defaults,
            environment: input.defaults.environment ? {
                ...input.defaults.environment,
            } : undefined,
        } : undefined,
        tasks: input.tasks.map(t => {
            const base = {
                name: t.name,
                workspace: t.workspace,
                // Pass grader descriptors through untouched
                graders: t.graders,
                solution: t.solution,
                agent: t.agent,
                trials: t.trials,
                timeout: t.timeout,
                grader_model: t.grader_model,
                environment: t.environment,
            };
            if (t.type === 'conversation') {
                return { ...base, type: 'conversation' as const, conversation: t.conversation };
            }
            return { ...base, type: t.type, instruction: t.instruction };
        }),
    };

    return validateConfig(raw);
}
```

- [x] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Errors in evalRunner.ts, conversationRunner.ts, commands/run.ts (will fix next)

- [x] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/define-eval.ts
git commit -m "refactor: pass GraderDescriptor through config validation untouched"
```

---

### Task 4: Update internal types and grader implementations

**Files:**
- Modify: `src/types.ts`
- Modify: `src/graders/index.ts`
- Modify: `src/graders/paths.ts`

- [x] **Step 1: Remove `command` from GraderConfig in types.ts**

In `src/types.ts`, change the `GraderConfig` interface:

```ts
export interface GraderConfig {
    type: 'deterministic' | 'llm_rubric' | 'tool_usage';
    rubric?: string;          // for llm_rubric: file path to rubric
    model?: string;           // for llm_rubric: LLM model override
    weight: number;
    expectations?: import('./core/config.types').ToolUsageExpectation[];  // for tool_usage
    include_tool_events?: boolean;  // for llm_rubric: opt-in to include tool events in transcript
}
```

(Removed `command?: string`)

- [x] **Step 2: Remove DeterministicGrader and getGrader from graders/index.ts**

Replace `src/graders/index.ts`:

```ts
import { GraderConfig, GraderResult, EnvironmentProvider, EnvironmentHandle, LogEntry } from '../types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { callLLM } from '../utils/llm';

export interface Grader {
    grade(
        workspace: EnvironmentHandle,
        provider: EnvironmentProvider,
        config: GraderConfig,
        taskPath: string,
        sessionLog: LogEntry[],
        env?: Record<string, string>,
        signal?: AbortSignal
    ): Promise<GraderResult>;
}

/**
 * Uses an LLM to evaluate the agent's session transcript against a rubric.
 * Requires a supported API key in the environment.
 */
export class LLMGrader implements Grader {
    // ... (keep the entire existing LLMGrader class unchanged)
}
```

Remove:
- The entire `DeterministicGrader` class (lines 29-82)
- The `getGrader` function (lines 274-282)
- The `ToolUsageGrader` import (line 5) — it's no longer needed in this file

Keep:
- `Grader` interface
- `LLMGrader` class (unchanged)

- [x] **Step 3: Remove deterministic path helpers from graders/paths.ts**

Replace `src/graders/paths.ts`:

```ts
/**
 * Shared grader path conventions. Single source of truth for the
 * .pathgrade directory structure used by prepareTempTaskDir (writer)
 * and evalRunner/conversationRunner (readers).
 */

export const GRADER_ROOT = '.pathgrade';
export const PROMPTS_DIR = `${GRADER_ROOT}/prompts`;
export const STEP_PROMPTS_DIR = `${PROMPTS_DIR}/steps`;

export function llmRubricName(index: number): string {
    return index === 0 ? 'quality.md' : `quality_${index}.md`;
}

export function llmRubricPath(index: number): string {
    return `${PROMPTS_DIR}/${llmRubricName(index)}`;
}

export function stepLlmRubricPath(turnNumber: number, graderIndex: number): string {
    return `${STEP_PROMPTS_DIR}/turn_${turnNumber}_${graderIndex}.md`;
}
```

Removed: `TESTS_DIR`, `STEP_TESTS_DIR`, `deterministicScriptName`, `deterministicCommand`, `stepDeterministicCommand`.

- [x] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Errors in evalRunner.ts, conversationRunner.ts, commands/run.ts (import references to removed items)

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/graders/index.ts src/graders/paths.ts
git commit -m "refactor: remove DeterministicGrader, getGrader, deterministic path helpers"
```

---

### Task 5: Update evalRunner to dispatch on GraderDescriptor

**Files:**
- Modify: `src/evalRunner.ts`
- Test: `tests/graders.test.ts` (add execute dispatch tests)

- [x] **Step 1: Write execute dispatch tests**

Add to `tests/graders.test.ts`:

```ts
import { GraderContext } from '../src/core/grader-factories';

describe('deterministic grader execute dispatch', () => {
  it('calls execute and returns GraderResult', async () => {
    const descriptor = deterministicGrader({
      weight: 0.7,
      execute: async ({ workspacePath }) => ({
        score: 0.8,
        details: `checked ${workspacePath}`,
      }),
    });

    const ctx: GraderContext = {
      workspacePath: '/workspace',
      runCommand: vi.fn(),
      sessionLog: [],
      env: {},
    };

    const output = await descriptor.execute!(ctx);
    expect(output.score).toBe(0.8);
    expect(output.details).toContain('/workspace');
  });

  it('score is clamped to [0, 1] by caller', async () => {
    const descriptor = deterministicGrader({
      execute: async () => ({ score: 2.5 }),
    });
    const ctx: GraderContext = {
      workspacePath: '/w',
      runCommand: vi.fn(),
      sessionLog: [],
      env: {},
    };
    const output = await descriptor.execute!(ctx);
    // Clamping is done by runGraders, not execute itself
    const clamped = Math.max(0, Math.min(1, output.score));
    expect(clamped).toBe(1.0);
  });

  it('runCommand closure delegates to provider', async () => {
    const mockProvider = {
      runCommand: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    };
    const runtime = '/workspace';
    const env = { FOO: 'bar' };
    const signal = new AbortController().signal;

    const ctx: GraderContext = {
      workspacePath: runtime,
      runCommand: (cmd: string) => mockProvider.runCommand(runtime, cmd, env, { signal }),
      sessionLog: [],
      env,
      signal,
    };

    await ctx.runCommand('ls');
    expect(mockProvider.runCommand).toHaveBeenCalledWith('/workspace', 'ls', env, { signal });
  });
});
```

- [x] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/graders.test.ts`
Expected: New tests PASS (they test descriptor behavior, not evalRunner internals)

- [x] **Step 3: Update evalRunner.ts imports and runGraders**

In `src/evalRunner.ts`, update imports:

```ts
import {
    AgentCommandRunner,
    BaseAgent,
    CommandExecutionOptions,
    EnvironmentHandle,
    EnvironmentProvider,
    EvalReport,
    GraderResult,
    LogEntry,
    TrialResult,
    createAgentSession,
    getWorkspacePath,
} from './types';
import { ResolvedConversation } from './core/config.types';
import type { GraderDescriptor, GraderContext } from './core/grader-factories';
import { LLMGrader } from './graders';
import { ToolUsageGrader } from './graders/tool-usage';
import { llmRubricPath } from './graders/paths';
import { fmt, Spinner } from './utils/cli';
import { withAbortTimeout } from './utils/timeout';
import { extractToolEvents } from './tool-event-extractors';
```

Removed: `getGrader`, `deterministicCommand`, `ResolvedGrader`.

Change `EvalRunOptions.graders` type:

```ts
export interface EvalRunOptions {
    instruction?: string;
    conversation?: ResolvedConversation;
    graders: GraderDescriptor[];
    timeoutSec: number;
    graderModel?: string;
    graderTimeoutSec?: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    authMode?: 'host' | 'isolated';
    agentName?: import('./core/config.types').AgentName;
}
```

Replace the entire `runGraders` method:

```ts
    private async runGraders(
        runtime: EnvironmentHandle,
        taskPath: string,
        opts: EvalRunOptions,
        sessionLog: LogEntry[],
        spinner: Spinner,
        env?: Record<string, string>
    ): Promise<{ graderResults: GraderResult[]; reward: number }> {
        const graderResults: GraderResult[] = [];

        for (let gIdx = 0; gIdx < opts.graders.length; gIdx++) {
            const descriptor = opts.graders[gIdx];
            spinner.update(`grading (${descriptor.type}${opts.graders.length > 1 ? ` ${gIdx + 1}/${opts.graders.length}` : ''})`);

            try {
                const graderTimeoutMs = (opts.graderTimeoutSec ?? 120) * 1000;
                const result = await withAbortTimeout(
                    async (signal) => this.executeGrader(descriptor, runtime, taskPath, opts, sessionLog, env, signal, gIdx),
                    graderTimeoutMs,
                    `Grader ${descriptor.type} (limit: ${opts.graderTimeoutSec ?? 120}s)`
                );
                graderResults.push(result);
            } catch (err: unknown) {
                const errorMsg = (err as Error)?.message || String(err);
                graderResults.push({
                    grader_type: descriptor.type,
                    score: 0,
                    weight: descriptor.weight,
                    details: `[grader error] ${errorMsg}`,
                });
            }

            sessionLog.push({
                type: 'grader',
                timestamp: this.timestamp(),
                grader_result: graderResults[graderResults.length - 1],
            });
        }

        const totalWeight = graderResults.reduce((sum, result) => sum + result.weight, 0);
        const reward = totalWeight > 0
            ? graderResults.reduce((sum, result) => sum + result.score * result.weight, 0) / totalWeight
            : 0;

        return { graderResults, reward };
    }

    private async executeGrader(
        descriptor: GraderDescriptor,
        runtime: EnvironmentHandle,
        taskPath: string,
        opts: EvalRunOptions,
        sessionLog: LogEntry[],
        env?: Record<string, string>,
        signal?: AbortSignal,
        graderIndex: number
    ): Promise<GraderResult> {
        if (descriptor.type === 'deterministic') {
            const ctx: GraderContext = {
                workspacePath: getWorkspacePath(runtime),
                runCommand: (cmd: string) => this.provider.runCommand(runtime, cmd, env, { signal }),
                sessionLog,
                env: env ?? {},
                signal,
            };
            try {
                const output = await descriptor.execute!(ctx);
                const score = Math.max(0, Math.min(1, parseFloat(String(output.score)) || 0));
                const details = output.details || `score=${score.toFixed(2)}`;
                const checks = output.checks || [];
                const checkLines = checks.map((c) =>
                    `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.message || ''}`
                );
                const fullDetails = checkLines.length > 0
                    ? `${details}\n${checkLines.join('\n')}`
                    : details;
                return {
                    grader_type: 'deterministic',
                    score,
                    weight: descriptor.weight,
                    details: fullDetails,
                };
            } catch (e: unknown) {
                return {
                    grader_type: 'deterministic',
                    score: 0,
                    weight: descriptor.weight,
                    details: `execute() threw: ${(e as Error)?.message || String(e)}`,
                };
            }
        }

        if (descriptor.type === 'llm_rubric') {
            const llmIndex = opts.graders.slice(0, graderIndex).filter((g) => g.type === 'llm_rubric').length;
            const graderConfig = {
                type: descriptor.type as const,
                rubric: llmRubricPath(llmIndex),
                model: descriptor.model || opts.graderModel,
                weight: descriptor.weight,
                include_tool_events: descriptor.include_tool_events,
            };
            const grader = new LLMGrader();
            return grader.grade(runtime, this.provider, graderConfig, taskPath, sessionLog, env, signal);
        }

        if (descriptor.type === 'tool_usage') {
            const graderConfig = {
                type: descriptor.type as const,
                weight: descriptor.weight,
                expectations: descriptor.expectations,
            };
            const grader = new ToolUsageGrader();
            return grader.grade(runtime, this.provider, graderConfig, taskPath, sessionLog, env, signal);
        }

        throw new Error(`Unknown grader type: ${descriptor.type}`);
    }
```

- [x] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Errors in conversationRunner.ts and commands/run.ts only

- [x] **Step 5: Commit**

```bash
git add src/evalRunner.ts tests/graders.test.ts
git commit -m "refactor: evalRunner dispatches on GraderDescriptor with GraderContext"
```

---

### Task 6: Update conversationRunner

**Files:**
- Modify: `src/conversationRunner.ts`

- [x] **Step 1: Update imports**

In `src/conversationRunner.ts`, update imports:

```ts
import { ResolvedConversation } from './core/config.types';
import type { GraderDescriptor, GraderContext } from './core/grader-factories';
import { LLMGrader } from './graders';
import { ToolUsageGrader } from './graders/tool-usage';
import { stepLlmRubricPath } from './graders/paths';
```

Remove: `getGrader`, `stepDeterministicCommand`.

- [x] **Step 2: Replace runStepGraders function**

Replace the `runStepGraders` function (lines 172-210):

```ts
async function runStepGraders(
    turnNumber: number,
    opts: ConversationRunOptions,
    sessionLog: LogEntry[]
): Promise<GraderResult[]> {
    const stepGraders = opts.conversation.step_graders;
    if (!stepGraders) return [];

    const results: GraderResult[] = [];
    for (const sg of stepGraders) {
        if (sg.after_turn !== turnNumber) continue;
        for (let graderIdx = 0; graderIdx < sg.graders.length; graderIdx++) {
            const descriptor = sg.graders[graderIdx];

            let result: GraderResult;

            if (descriptor.type === 'deterministic') {
                const ctx: GraderContext = {
                    workspacePath: getWorkspacePath(opts.runtime),
                    runCommand: (cmd: string) => opts.provider.runCommand(opts.runtime, cmd, opts.env),
                    sessionLog,
                    env: opts.env ?? {},
                };
                try {
                    const output = await descriptor.execute!(ctx);
                    const score = Math.max(0, Math.min(1, parseFloat(String(output.score)) || 0));
                    result = {
                        grader_type: 'deterministic',
                        score,
                        weight: descriptor.weight,
                        details: output.details || `score=${score.toFixed(2)}`,
                    };
                } catch (e: unknown) {
                    result = {
                        grader_type: 'deterministic',
                        score: 0,
                        weight: descriptor.weight,
                        details: `execute() threw: ${(e as Error)?.message || String(e)}`,
                    };
                }
            } else if (descriptor.type === 'llm_rubric') {
                const graderConfig = {
                    type: descriptor.type as const,
                    rubric: stepLlmRubricPath(turnNumber, graderIdx),
                    model: descriptor.model || opts.graderModel,
                    weight: descriptor.weight,
                    include_tool_events: descriptor.include_tool_events,
                };
                const grader = new LLMGrader();
                result = await grader.grade(
                    opts.runtime, opts.provider, graderConfig,
                    opts.taskPath, sessionLog, opts.env
                );
            } else if (descriptor.type === 'tool_usage') {
                const graderConfig = {
                    type: descriptor.type as const,
                    weight: descriptor.weight,
                    expectations: descriptor.expectations,
                };
                const grader = new ToolUsageGrader();
                result = await grader.grade(
                    opts.runtime, opts.provider, graderConfig,
                    opts.taskPath, sessionLog, opts.env
                );
            } else {
                throw new Error(`Unknown step grader type: ${descriptor.type}`);
            }

            results.push(result);
            sessionLog.push({
                type: 'step_grader',
                timestamp: opts.timestamp(),
                turn_number: turnNumber,
                step_grader_key: `turn_${turnNumber}_${graderIdx}`,
                grader_result: result,
            });
        }
    }
    return results;
}
```

- [x] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Errors in commands/run.ts only

- [x] **Step 4: Commit**

```bash
git add src/conversationRunner.ts
git commit -m "refactor: conversationRunner dispatches on GraderDescriptor"
```

---

### Task 7: Simplify prepareTempTaskDir

**Files:**
- Modify: `src/commands/run.ts`

- [x] **Step 1: Update imports in run.ts**

Update the imports from `graders/paths`:

```ts
import {
    PROMPTS_DIR,
    STEP_PROMPTS_DIR,
    llmRubricName,
} from '../graders/paths';
```

Remove: `TESTS_DIR`, `STEP_TESTS_DIR`, `deterministicScriptName`.

- [x] **Step 2: Simplify prepareTempTaskDir**

Replace the `prepareTempTaskDir` function:

```ts
export async function prepareTempTaskDir(
    resolved: ResolvedTask,
    baseDir: string,
    tmpDir: string
) {
    await fs.ensureDir(tmpDir);

    // Write each LLM rubric
    await fs.ensureDir(path.join(tmpDir, PROMPTS_DIR));
    const llmGraders = resolved.graders.filter(g => g.type === 'llm_rubric');
    for (let i = 0; i < llmGraders.length; i++) {
        if (llmGraders[i].rubric) {
            await fs.writeFile(path.join(tmpDir, PROMPTS_DIR, llmRubricName(i)), llmGraders[i].rubric!);
        }
    }

    // Write step grader rubrics
    const stepGraders = resolved.type === 'conversation' ? resolved.conversation.step_graders : undefined;
    if (stepGraders) {
        await fs.ensureDir(path.join(tmpDir, STEP_PROMPTS_DIR));
        for (const sg of stepGraders) {
            for (let gIdx = 0; gIdx < sg.graders.length; gIdx++) {
                const g = sg.graders[gIdx];
                if (g.type === 'llm_rubric' && g.rubric) {
                    await fs.writeFile(
                        path.join(tmpDir, STEP_PROMPTS_DIR, `turn_${sg.after_turn}_${gIdx}.md`),
                        g.rubric
                    );
                }
            }
        }
    }

    // Copy workspace files into the local task bundle.
    for (const w of resolved.workspace) {
        const srcPath = path.resolve(baseDir, w.src);
        if (!isContainedIn(srcPath, baseDir)) {
            console.warn(`  ${fmt.dim('warning')}  workspace src "${w.src}" escapes project directory, skipping`);
            continue;
        }
        const destName = w.dest || path.basename(w.src);
        const destInTmp = path.join(tmpDir, destName);
        if (await fs.pathExists(srcPath)) {
            await fs.copy(srcPath, destInTmp);
            if (w.chmod) {
                await fs.chmod(destInTmp, w.chmod);
            }
        }
    }
}
```

- [x] **Step 3: Verify full compilation**

Run: `npx tsc --noEmit`
Expected: PASS — all type errors resolved

- [x] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: Some existing tests may fail due to old API usage — we'll fix those in the next task

- [x] **Step 5: Commit**

```bash
git add src/commands/run.ts
git commit -m "refactor: simplify prepareTempTaskDir — remove deterministic script staging"
```

---

### Task 8: Update grader tests

**Files:**
- Modify: `tests/graders.test.ts`

- [x] **Step 1: Remove DeterministicGrader tests**

Remove the entire `describe('DeterministicGrader', ...)` block (lines 40-143).

Remove the `describe('getGrader', ...)` block (lines 473-491).

Update imports at top:

```ts
import { LLMGrader } from '../src/graders/index';
import { ToolUsageGrader } from '../src/graders/tool-usage';
import { GraderConfig, EnvironmentProvider } from '../src/types';
```

Remove: `DeterministicGrader`, `getGrader` from the import.

- [x] **Step 2: Add config validation tests**

Add a new describe block:

```ts
describe('config validation for grader descriptors', () => {
  it('throws when deterministic grader is missing execute', () => {
    expect(() => {
      const { validateConfig } = require('../src/core/config');
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'deterministic', weight: 1.0 }],
        }],
      });
    }).toThrow('must have an "execute" function');
  });

  it('throws when llm_rubric grader is missing rubric', () => {
    expect(() => {
      const { validateConfig } = require('../src/core/config');
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'llm_rubric', weight: 1.0 }],
        }],
      });
    }).toThrow('must have a "rubric" string');
  });

  it('throws when tool_usage grader is missing expectations', () => {
    expect(() => {
      const { validateConfig } = require('../src/core/config');
      validateConfig({
        version: '1',
        tasks: [{
          name: 'test',
          type: 'instruction',
          instruction: 'do something',
          graders: [{ type: 'tool_usage', weight: 1.0 }],
        }],
      });
    }).toThrow('must have an "expectations" array');
  });
});
```

- [x] **Step 3: Run all tests**

Run: `npx vitest run tests/graders.test.ts`
Expected: All tests PASS

- [x] **Step 4: Commit**

```bash
git add tests/graders.test.ts
git commit -m "test: replace DeterministicGrader tests with factory/descriptor tests"
```

---

### Task 9: Migrate pathgrade.eval.ts graders

**Files:**
- Create: `graders/check-eval-ts.ts`
- Delete: `graders/check-eval-ts.js`
- Modify: `pathgrade.eval.ts`

- [x] **Step 1: Create graders/check-eval-ts.ts**

```ts
import { deterministicGrader } from '../src/core/grader-factories';
import * as fs from 'fs';

export const checkEvalTs = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        // Find *.eval.ts file
        const files = fs.readdirSync(workspacePath);
        const evalFile = files.find(f => f.endsWith('.eval.ts')) || (fs.existsSync(`${workspacePath}/eval.ts`) ? 'eval.ts' : null);
        const exists = evalFile !== null;
        checks.push({ name: 'file-exists', passed: exists, message: exists ? `${evalFile} exists` : 'No *.eval.ts found' });

        if (!exists) {
            return { score: 0, details: '0/5 checks passed — no *.eval.ts found', checks };
        }

        const content = fs.readFileSync(`${workspacePath}/${evalFile}`, 'utf8');

        // Check: imports defineEval
        const hasDefineEval = /defineEval/.test(content);
        checks.push({ name: 'has-define-eval', passed: hasDefineEval, message: hasDefineEval ? 'uses defineEval()' : 'Missing defineEval import' });

        // Check: has tasks array
        const hasTasks = /tasks\s*:/.test(content);
        checks.push({ name: 'has-tasks', passed: hasTasks, message: hasTasks ? 'tasks defined' : 'Missing tasks' });

        // Check: has deterministic grader (new API pattern)
        const hasDeterministic = /deterministicGrader\s*\(/.test(content);
        checks.push({ name: 'has-deterministic', passed: hasDeterministic, message: hasDeterministic ? 'Has deterministicGrader()' : 'Missing deterministicGrader()' });

        // Check: has llm_rubric grader (new API pattern)
        const hasLlmRubric = /llmRubricGrader\s*\(/.test(content);
        checks.push({ name: 'has-llm-rubric', passed: hasLlmRubric, message: hasLlmRubric ? 'Has llmRubricGrader()' : 'Missing llmRubricGrader()' });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
```

- [x] **Step 2: Create graders/check-grader-authoring.ts for task 2**

```ts
import { deterministicGrader } from '../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkGraderAuthoring = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        // Check 1: grader .ts file exists in graders/
        const gradersDir = path.join(workspacePath, 'graders');
        let graderFile: string | null = null;
        if (fs.existsSync(gradersDir)) {
            const files = fs.readdirSync(gradersDir).filter(f => f.endsWith('.ts'));
            if (files.length > 0) graderFile = files[0];
        }
        checks.push({
            name: 'grader-file-exists',
            passed: graderFile !== null,
            message: graderFile ? `Found graders/${graderFile}` : 'No .ts file in graders/',
        });

        if (!graderFile) {
            return { score: 0, details: '0/4 checks passed', checks };
        }

        const content = fs.readFileSync(path.join(gradersDir, graderFile), 'utf8');

        // Check 2: uses deterministicGrader factory
        const usesFactory = /deterministicGrader\s*\(/.test(content);
        checks.push({
            name: 'uses-factory',
            passed: usesFactory,
            message: usesFactory ? 'Uses deterministicGrader()' : 'Missing deterministicGrader() call',
        });

        // Check 3: has execute function
        const hasExecute = /execute\s*:/.test(content);
        checks.push({
            name: 'has-execute',
            passed: hasExecute,
            message: hasExecute ? 'Has execute function' : 'Missing execute function',
        });

        // Check 4: exports a grader
        const hasExport = /export\s/.test(content);
        checks.push({
            name: 'has-export',
            passed: hasExport,
            message: hasExport ? 'Exports grader' : 'Missing export',
        });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
```

- [x] **Step 3: Update pathgrade.eval.ts**

Replace `pathgrade.eval.ts`:

```ts
import { defineEval } from './src/core/define-eval';
import { llmRubricGrader } from './src/core/grader-factories';
import { checkEvalTs } from './graders/check-eval-ts';
import { checkGraderAuthoring } from './graders/check-grader-authoring';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 600,
    threshold: 0.7,
    environment: {
      cpus: 2,
      memory_mb: 2048,
    },
  },

  tasks: [
    {
      name: 'create-eval-config',
      type: 'instruction',
      instruction: `A skill called "code-formatter" is defined in SKILL.md.
Create a valid eval.ts that evaluates this skill using defineEval().

Requirements:
1. The eval.ts must import defineEval from '@wix/pathgrade'
2. It must define at least one task under tasks
3. Each task must have: name, instruction, workspace, and graders
4. Include at least one deterministicGrader() and one llmRubricGrader()
5. The deterministicGrader must have an execute function that returns { score, details }
6. The instruction for each task should be specific and actionable
7. Save the file as eval.ts in the current directory`,

      workspace: [
        { src: 'fixtures/code-formatter-skill.md', dest: 'SKILL.md' },
      ],

      graders: [
        checkEvalTs,
        llmRubricGrader({
          rubric: `Evaluate the generated eval.ts quality:

Structure (0-0.4):
- Does eval.ts use defineEval() correctly?
- Are defaults sensibly configured?
- Does it define at least one well-structured task?

Task Quality (0-0.3):
- Is the instruction specific enough for an agent to follow?
- Are workspace files mapped correctly?
- Are grader weights reasonable?

Grader Design (0-0.3):
- Does it include both deterministicGrader() and llmRubricGrader()?
- Is the deterministic grader checking concrete outcomes via execute()?
- Is the LLM rubric focused on qualitative assessment?`,
          weight: 0.3,
        }),
      ],
    },

    {
      name: 'write-deterministic-grader',
      type: 'instruction',
      instruction: `Write a deterministic grader for a pathgrade evaluation.

The grader should verify that a file called output.txt was created
and contains the text "Hello, World!".

Requirements:
1. Create a TypeScript file at graders/check-output.ts
2. Import deterministicGrader from '@wix/pathgrade'
3. Export a grader using deterministicGrader({ execute: ... })
4. The execute function should return { score, details, checks }
5. Check 1: verify output.txt exists
6. Check 2: verify output.txt contains "Hello, World!"
7. Score should be the proportion of checks that passed`,

      workspace: [
        { src: 'fixtures/sample-output.txt', dest: 'expected-output.txt' },
      ],

      graders: [
        checkGraderAuthoring,
        llmRubricGrader({
          rubric: `Evaluate the grader file quality:

Correctness (0-0.4):
- Does the file use deterministicGrader() factory?
- Does it export the grader?
- Does execute() return { score, details, checks }?

Robustness (0-0.3):
- Does it handle the case where output.txt doesn't exist?
- Does it use proper async/await patterns?

Code Quality (0-0.3):
- Is the code well-structured and readable?
- Are check results descriptive?`,
          weight: 0.3,
        }),
      ],
    },
  ],
});
```

- [x] **Step 4: Delete the old JS grader**

```bash
rm graders/check-eval-ts.js
```

- [x] **Step 5: Run compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add graders/check-eval-ts.ts graders/check-grader-authoring.ts pathgrade.eval.ts
git rm graders/check-eval-ts.js
git commit -m "refactor: migrate pathgrade.eval.ts to grader descriptors"
```

---

### Task 10: Migrate examples/ck-new eval

**Files:**
- Create: `examples/ck-new/graders/check-fix.ts`
- Create: `examples/ck-new/graders/check-brief.ts`
- Delete: `examples/ck-new/graders/check-fix.js`
- Delete: `examples/ck-new/graders/check-brief.js`
- Modify: `examples/ck-new/ck-new.eval.ts`

- [x] **Step 1: Create graders/check-fix.ts**

```ts
import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkFix = deterministicGrader({
    weight: 0.6,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const appPath = path.join(workspacePath, 'app.js');
        const exists = fs.existsSync(appPath);
        checks.push({
            name: 'file-exists',
            passed: exists,
            message: exists ? 'app.js exists' : 'app.js not found',
        });

        if (!exists) {
            return { score: 0, details: '0/2 — file not found', checks };
        }

        try {
            // Clear require cache and test the function
            try { delete require.cache[require.resolve(appPath)]; } catch {}
            const { add } = require(appPath);
            const result = add(2, 3);
            const correct = result === 5;
            checks.push({
                name: 'add-correct',
                passed: correct,
                message: correct ? 'add(2,3) = 5' : `add(2,3) = ${result}, expected 5`,
            });
        } catch (e: unknown) {
            checks.push({
                name: 'add-correct',
                passed: false,
                message: `Error: ${(e as Error).message}`,
            });
        }

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
```

- [x] **Step 2: Create graders/check-brief.ts**

```ts
import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkBrief = deterministicGrader({
    weight: 0.5,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];
        const artifactsDir = path.join(workspacePath, 'artifacts');

        let briefPath: string | null = null;
        if (fs.existsSync(artifactsDir)) {
            const files = fs.readdirSync(artifactsDir)
                .filter(f => /^project-brief-.*\.md$/.test(f));
            if (files.length > 0) {
                briefPath = path.join(artifactsDir, files[0]);
            }
        }

        checks.push({
            name: 'brief-exists',
            passed: briefPath !== null,
            message: briefPath ? `Found ${briefPath}` : 'No project-brief-*.md found in artifacts/',
        });

        if (!briefPath) {
            return { score: 0, details: '0/5 checks passed — brief file not found', checks };
        }

        const content = fs.readFileSync(briefPath, 'utf-8');

        const hasContext = /^##\s+Context/m.test(content);
        checks.push({ name: 'has-context', passed: hasContext, message: hasContext ? 'Has Context section' : 'Missing Context section' });

        const hasDirection = /^##\s+Direction/m.test(content);
        checks.push({ name: 'has-direction', passed: hasDirection, message: hasDirection ? 'Has Direction section' : 'Missing Direction section' });

        const hasGoal = /^##\s+Goal/m.test(content);
        checks.push({ name: 'has-goal', passed: hasGoal, message: hasGoal ? 'Has Goal section' : 'Missing Goal section' });

        const hasTargetGroup = /^##\s+Target\s+Group/m.test(content);
        checks.push({ name: 'has-target-group', passed: hasTargetGroup, message: hasTargetGroup ? 'Has Target Group section' : 'Missing Target Group section' });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
```

- [x] **Step 3: Update ck-new.eval.ts**

Replace `examples/ck-new/ck-new.eval.ts`:

```ts
import { defineEval } from '../../src/core/define-eval';
import { llmRubricGrader, toolUsageGrader } from '../../src/core/grader-factories';
import { checkFix } from './graders/check-fix';
import { checkBrief } from './graders/check-brief';

export default defineEval({
  skillPath: 'skill',

  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.6,
  },

  tasks: [
    {
      name: 'tool-aware-fix',
      type: 'instruction',
      instruction: 'Read app.js, find the bug in the add function, and fix it so add(2,3) returns 5.',
      agent: 'claude',
      workspace: [
        { src: 'fixtures/buggy-app.js', dest: 'app.js' },
        { src: 'fixtures/solve-fix.sh', dest: 'solve-fix.sh' },
      ],
      solution: 'solve-fix.sh',
      trials: 1,
      timeout: 120,
      graders: [
        checkFix,
        toolUsageGrader({
          weight: 0.4,
          expectations: [
            { action: 'read_file', argument_pattern: 'app\\.js', min: 1, weight: 0.5 },
            { action: 'edit_file', min: 1, weight: 0.5 },
          ],
        }),
      ],
    },

    {
      name: 'scripted-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a gift card feature.\n`,
        completion: { max_turns: 12, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        replies: [
          { content: `It's for the Wix Stores platform. Online store owners have been\nrequesting the ability to sell digital gift cards that customers\ncan purchase and redeem at checkout.\n` },
          { content: "Yes, that's right", when: "right\\?|correct\\?|confirm|sound right" },
          { content: 'Solve user pain point', when: 'goal|trying to achieve|what are you trying' },
          { content: 'Self-Creator', when: 'target|audience|who|Self-Creator|adjust if needed' },
          { content: 'Skip', when: 'knowledge base|KB.*MCP|enrich.*brief|paste.*doc.*skip' },
          { content: 'Skip for now', when: 'gameplan|strategy doc' },
          { content: 'Looks good, no changes', when: "look right|approve|feedback|changes|edit|you'd change|anything.*change|move on|before moving" },
          { content: 'No, skip repos for now', when: 'github|repo|reference' },
        ],
      },
      graders: [
        checkBrief,
        llmRubricGrader({
          rubric: `Evaluate the multi-turn conversation for ck-new skill compliance.

Workflow (0-0.4):
- Did the agent ask questions one at a time (not multiple in one message)?
- Did the agent follow check→direction→goal→target flow?
- Did it offer structured choices for Goal and Target Group?

Brief Quality (0-0.4):
- Is the brief at artifacts/project-brief-*.md?
- Does it have all required sections (Context, Direction, Goal, Target Group)?
- Is content refined (not just echoing user replies)?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary back-and-forth)?
- Did the agent react naturally to user responses?`,
          weight: 0.5,
        }),
      ],
    },

    {
      name: 'persona-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a feature\nrelated to gift cards for online stores.\n`,
        completion: { max_turns: 15, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        persona: {
          description: `You are a product manager at Wix who has worked on the Stores\nplatform for 2 years. You communicate directly and concisely.\nWhen asked a multiple-choice question, pick the most appropriate\noption. When asked for confirmation, confirm if correct. You're\ncollaborative but don't volunteer extra information unless asked.\n`,
          facts: [
            'The feature is for the Wix Stores platform',
            'Target users are Self-Creators (store owners managing their own shops)',
            'Goal: solve user pain point — store owners can\'t offer gift cards and lose revenue',
            'Direction: custom gift card designs, set denominations, email delivery, checkout redemption',
            'You don\'t know technical implementation details',
            'No GitHub repos to link right now',
            'No gameplan link available',
            'The project name should be \'gift-card\' or similar',
          ],
        },
      },
      graders: [
        checkBrief,
        llmRubricGrader({
          rubric: `Evaluate the full persona-driven conversation.

Skill Discovery (0-0.2):
- Did the agent discover and use ck-new?

Conversation Flow (0-0.4):
- One question per turn?
- Adapted to user's communication style?
- Handled open-ended responses well?

Brief Quality (0-0.4):
- Complete brief with all sections?
- Content matches the facts the persona provided?
- Project name reasonable?`,
          weight: 0.5,
        }),
      ],
    },
  ],
});
```

- [x] **Step 4: Delete old JS graders**

```bash
rm examples/ck-new/graders/check-fix.js examples/ck-new/graders/check-brief.js
```

- [x] **Step 5: Commit**

```bash
git add examples/ck-new/graders/check-fix.ts examples/ck-new/graders/check-brief.ts examples/ck-new/ck-new.eval.ts
git rm examples/ck-new/graders/check-fix.js examples/ck-new/graders/check-brief.js
git commit -m "refactor: migrate ck-new eval to grader descriptors"
```

---

### Task 11: Migrate remaining example evals

**Files:**
- Create: `examples/tool-usage/graders/check.ts`
- Modify: `examples/tool-usage/tool-usage.eval.ts`
- Create: `examples/angular-modern/graders/check-modern-apis.ts`
- Delete: `examples/angular-modern/graders/check-modern-apis.js`
- Modify: `examples/angular-modern/angular-modern.eval.ts`
- Create: `examples/ck-product-strategy/graders/check-strategy.ts`
- Delete: `examples/ck-product-strategy/graders/check-strategy.js`
- Modify: `examples/ck-product-strategy/ck-product-strategy.eval.ts`
- Create: `examples/superlint/graders/check-lint.ts`
- Modify: `examples/superlint/superlint.eval.ts`
- Create: `examples/typescript-example/graders/check-output.ts`
- Modify: `examples/typescript-example/typescript-example.eval.ts`

This task migrates the remaining 5 example evals. Each grader script is converted from JS/bash to a TS file exporting a `GraderDescriptor`. Each eval file is updated to import from the new grader files and use factory functions.

The conversion pattern is identical across all files:
1. Read the existing `.js` grader logic
2. Wrap it in `deterministicGrader({ execute: async ({ workspacePath }) => { ... } })`
3. Replace `console.log(JSON.stringify(...))` with `return { score, details, checks }`
4. Replace relative `fs` paths with `path.join(workspacePath, ...)`
5. Update the eval file to import the descriptor and use factory functions for LLM/tool_usage graders

Due to the mechanical nature and volume of these migrations, the implementer should:

- [x] **Step 1: Create all 5 grader .ts files**

Create each file following the pattern shown in Task 10. The logic is ported directly from the existing `.js` files or inline bash scripts. Key changes per file:

**`examples/tool-usage/graders/check.ts`** — Create from scratch (no existing `.js`). The eval tests a bug fix in `app.js`, so the grader should check that `app.js` was modified and the fix is correct (similar to `check-fix.ts` from Task 10).

**`examples/angular-modern/graders/check-modern-apis.ts`** — Port from `check-modern-apis.js`. Same 5 regex checks (signal inputs, inject(), control flow, signal outputs, no CommonModule), wrapped in `deterministicGrader`.

**`examples/ck-product-strategy/graders/check-strategy.ts`** — Port from `check-strategy.js`. Same 8 section checks, wrapped in `deterministicGrader`.

**`examples/superlint/graders/check-lint.ts`** — Port from inline bash:

```ts
import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkLint = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const passedFile = path.join(workspacePath, '.superlint-passed');
        const hasPassed = fs.existsSync(passedFile);
        checks.push({
            name: 'superlint-passed',
            passed: hasPassed,
            message: hasPassed ? 'Verification file exists' : 'Verification file missing',
        });

        const appPath = path.join(workspacePath, 'app.js');
        let codeFixed = false;
        if (fs.existsSync(appPath)) {
            const content = fs.readFileSync(appPath, 'utf-8');
            codeFixed = content.includes("const greeting = 'hello world';");
        }
        checks.push({
            name: 'code-fixed',
            passed: codeFixed,
            message: codeFixed ? 'Code uses const and single quotes' : 'Code not properly fixed',
        });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
```

**`examples/typescript-example/graders/check-output.ts`** — Port from inline bash:

```ts
import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkOutput = deterministicGrader({
    weight: 1.0,
    execute: async ({ workspacePath }) => {
        const filePath = path.join(workspacePath, 'output.txt');
        if (!fs.existsSync(filePath)) {
            return { score: 0, details: 'output.txt missing or wrong content' };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('hello world')) {
            return { score: 1, details: 'output.txt contains hello world' };
        }
        return { score: 0, details: 'output.txt missing or wrong content' };
    },
});
```

- [x] **Step 2: Update all 5 eval files to use imports and factories**

Replace `{ type: 'deterministic', run: '...', weight: N }` with imported descriptor.
Replace `{ type: 'llm_rubric', rubric: '...', weight: N }` with `llmRubricGrader({ ... })`.
Replace `{ type: 'tool_usage', expectations: [...], weight: N }` with `toolUsageGrader({ ... })`.

**Important:** `tool-usage.eval.ts` and `ck-product-strategy.eval.ts` currently import from `'@wix/pathgrade'` (package name). Switch these to relative imports like the other examples — e.g., `import { defineEval } from '../../src/core/define-eval'` and `import { llmRubricGrader } from '../../src/core/grader-factories'`. This avoids requiring a package build during development.

- [x] **Step 3: Delete old .js grader files**

```bash
rm examples/angular-modern/graders/check-modern-apis.js
rm examples/ck-product-strategy/graders/check-strategy.js
```

- [x] **Step 4: Verify full compilation**

Run: `npx tsc --noEmit`
Expected: PASS

- [x] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [x] **Step 6: Commit**

```bash
git add examples/*/graders/*.ts examples/*/*.eval.ts
git rm examples/angular-modern/graders/check-modern-apis.js examples/ck-product-strategy/graders/check-strategy.js
git commit -m "refactor: migrate all remaining example evals to grader descriptors"
```

---

### Task 12: Update init.ts templates

**Files:**
- Modify: `src/commands/init.ts`

- [x] **Step 1: Update buildInitPrompt template**

In `src/commands/init.ts`, update `buildInitPrompt()` (around line 153). Replace the grader format instructions and example template to use factory functions:

Change the instruction text from:
```
- Write a deterministic grader (shell script that outputs JSON to stdout)
```
to:
```
- Write a deterministic grader using deterministicGrader({ execute: ... }) that returns { score, details, checks }
```

Replace the `IMPORTANT GRADING RULES` section to reference the new API:
```
IMPORTANT GRADING RULES:
- Deterministic graders use deterministicGrader({ execute: async (ctx) => { ... } })
- The execute function receives ctx with: workspacePath, runCommand, sessionLog, env
- It must return: { score: 0.0-1.0, details: "...", checks: [{name, passed, message}] }
- LLM rubric graders use llmRubricGrader({ rubric: '...', weight: N })
```

Replace the example template at the end of the prompt from old format:
```ts
import { defineEval, deterministicGrader, llmRubricGrader } from '@wix/pathgrade';

export default defineEval({
  defaults: { agent: 'gemini', trials: 5, timeout: 300, threshold: 0.8 },
  tasks: [
    {
      name: '<descriptive-task-name>',
      type: 'instruction',
      instruction: \`<realistic user instruction>
Save <expected output> as <exact-filename>.\`,
      workspace: [],
      graders: [
        deterministicGrader({
          weight: 0.7,
          execute: async ({ workspacePath }) => {
            // Check conditions and return result
            return { score: 0.0, details: '...', checks: [] };
          },
        }),
        llmRubricGrader({
          rubric: \`<evaluation criteria>\`,
          weight: 0.3,
        }),
      ],
    },
  ],
});
```

- [x] **Step 2: Update getInlineTemplate**

Replace the `getInlineTemplate()` function (around line 234) with the same new format — `deterministicGrader({ execute })` and `llmRubricGrader({ rubric })` instead of `{ type: 'deterministic', run: '...' }`.

- [x] **Step 3: Commit**

```bash
git add src/commands/init.ts
git commit -m "refactor: update init.ts templates to use grader factory functions"
```

---

### Task 13: Final verification

- [x] **Step 1: Full compilation check**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

- [x] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [x] **Step 3: Verify no old API references remain**

Run: `grep -r "getGrader\|DeterministicGrader\|EvalGraderConfig\|DefineEvalGraderInput\|deterministicCommand\|deterministicScriptName\|TESTS_DIR\|STEP_TESTS_DIR" src/ tests/ --include='*.ts' -l`
Expected: No matches (or only in `.d.ts` build artifacts)

Run: `grep -r "run: '" examples/ pathgrade.eval.ts --include='*.ts' -l`
Expected: No matches — all `run:` fields are gone

- [x] **Step 4: Verify no stale .js grader files remain**

Run: `find . -path ./node_modules -prune -o -path ./.worktrees -prune -o -path ./dist -prune -o -name '*.js' -path '*/graders/*' -print`
Expected: No matches

- [x] **Step 5: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final cleanup for grader descriptor refactor"
```
