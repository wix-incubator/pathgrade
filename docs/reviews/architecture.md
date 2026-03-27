# Architecture & Module Design Review

**Date**: 2026-03-26
**Scope**: Structural integrity of the pathgrade codebase -- dependency direction, module boundaries, abstraction quality, data flow, type architecture, and export surface.

---

## 1. Dependency Direction

### 1.1 `[minor]` `commands/init.ts` duplicates LLM call logic instead of using `utils/llm.ts`

`src/commands/init.ts:220-295` contains a full `generateWithLLM()` function that manually calls Gemini, Anthropic, and OpenAI APIs with hand-rolled `fetch` logic. This is a near-duplicate of the multi-provider dispatch already implemented in `src/utils/llm.ts:97-261` (`callGemini`, `callAnthropic`, `callOpenAI`).

When a new provider is added or an API contract changes, both locations must be updated independently. The `init.ts` version also lacks the CLI-first fallback and the `inferProviderFromModel` routing that `utils/llm.ts` provides.

**Recommendation**: Replace `generateWithLLM()` with a call to `callLLM()` from `utils/llm.ts`, passing the prompt and appropriate options. The only difference is that `init.ts` uses `temperature: 0.3` while `callLLM` defaults to `0`, which is already supported via the `temperature` option.

### 1.2 `[nit]` `agents/registry.ts` imports from `core/config.types` -- acceptable cross-layer reference

`src/agents/registry.ts:10` imports `AgentName` from `core/config.types`. This is a type-only import used for the registry map key, so the coupling is minimal and directionally fine (agents depend on core types, not vice versa).

### 1.3 `[nit]` Clean dependency graph overall

The dependency direction is well-structured: `commands -> evalRunner -> agents/graders/providers -> types`. No circular dependencies were found. The `core/` module is imported only by `commands/` and `agents/registry`, which is appropriate.

---

## 2. Module Boundaries

### 2.1 `[major]` `commands/run.ts` has too many responsibilities

`src/commands/run.ts:40-224` (the `runEvals` function) handles:
- Config loading and environment variable assembly
- Skill detection and path resolution
- Eval filtering by name
- Output directory setup
- Building `EvalRunOptions` with grader filtering and auth-mode resolution
- Temp directory preparation (delegated to `prepareTempTaskDir`)
- Validation mode with a synthetic agent
- Normal eval mode with result formatting
- CI threshold checking

This is the "orchestrator" function, which is reasonable for a CLI tool, but at ~185 lines with deeply nested conditionals (conversation vs. instruction branching at line 127-146, validate vs. normal at line 152-209), it is approaching god-function territory.

**Recommendation**: Extract at least two pieces: (1) a `buildEvalOptions(resolved, opts)` helper that encapsulates the conversation-vs-instruction branching and grader filtering, and (2) the validation-mode logic into its own function. This would make `runEvals` a cleaner linear pipeline.

### 2.2 `[major]` Grader path conventions are scattered as implicit contracts

The `.pathgrade/tests/` and `.pathgrade/prompts/` path conventions are hardcoded in three separate locations with no shared constant:
- `src/commands/run.ts:243-276` (`prepareTempTaskDir` writes to these paths)
- `src/evalRunner.ts:348-353` (constructs grader commands referencing these paths)
- `src/conversationRunner.ts:187-191` (constructs step-grader commands referencing these paths)

The naming convention (`test.sh` for index 0, `test_N.sh` for N > 0) is replicated identically in all three places. If the convention changes, all three must be updated in lockstep.

**Recommendation**: Extract the path-building logic into a shared module (e.g., `src/graders/paths.ts`) with functions like `graderScriptPath(type, index)` and `rubricPath(index)`. Both the writer (`prepareTempTaskDir`) and the readers (`evalRunner`, `conversationRunner`) would import from the same source of truth.

### 2.3 `[minor]` `src/types.ts` mixes runtime abstractions with data shapes

`src/types.ts` contains:
- Pure data interfaces (`CommandResult`, `GraderResult`, `TrialResult`, `EvalReport`, `LogEntry`) -- serialized to JSON
- Runtime abstractions (`BaseAgent`, `EnvironmentProvider`, `AgentSession`) -- behavioral contracts
- Helper functions (`getWorkspacePath`, `getRuntimeHandle`, `createAgentSession`)

This single 243-line file serves as the "shared kernel" of the project, which is defensible at this scale. However, the mix of serializable data types with abstract classes and factory functions makes it harder to reason about what is a contract boundary vs. what is an implementation detail.

**Recommendation**: Consider splitting into `types/data.ts` (pure interfaces for serialization) and `types/runtime.ts` (abstract classes, provider/agent contracts, helper functions). The current barrel `types.ts` could re-export both.

---

## 3. Abstraction Quality

### 3.1 `[major]` `createAgentSession` uses `as any` to bypass the type system

`src/types.ts:168-197` implements `createAgentSession` with five `as any` casts to duck-type check whether an agent implements `createSession()` or `run()`. This undermines the `BaseAgent` abstract class contract -- the function explicitly works around the type system rather than relying on it.

The root cause is that `BaseAgent.createSession` (line 200) calls `createAgentSession(this, ...)`, creating a mutual recursion. The free function checks `agent.createSession !== BaseAgent.prototype.createSession` to detect overrides, which is a fragile runtime reflection pattern.

All three concrete agents (`ClaudeAgent`, `GeminiAgent`, `CodexAgent`) override `createSession` directly and never use the `run()`-based fallback path in `createAgentSession`. The fallback exists for hypothetical external agents that only implement `run()`.

**Recommendation**: Make the `AgentSession` the primary contract. Remove the `run()` abstract method from `BaseAgent` (it is legacy) and have `createAgentSession` simply call `agent.createSession()`. If backward compatibility with `run()`-only agents is needed, provide a `SimpleAgent` base class that wraps `run()` into a session. This eliminates all `as any` casts.

### 3.2 `[minor]` `EnvironmentHandle` union type is confusing

`src/types.ts:137`: `export type EnvironmentHandle = string | TrialRuntime;`

The `string` variant exists as a legacy path, but `LocalProvider.setup()` always returns a `TrialRuntime` object. The helper functions `getWorkspacePath`, `getRuntimeHandle`, and `getRuntimeEnv` all branch on `typeof handle === 'string'`, adding unnecessary complexity. No current code path produces a bare string handle.

**Recommendation**: Narrow `EnvironmentHandle` to just `TrialRuntime`. If other providers are added that use a string handle, they can wrap it in a minimal `TrialRuntime`.

### 3.3 `[nit]` Agent extensibility is good

Adding a new agent requires: (1) creating a class extending `BaseAgent` in `src/agents/`, (2) adding a line to `AGENT_REGISTRY` in `src/agents/registry.ts`, and (3) adding the name to `VALID_AGENTS` in `src/core/config.types.ts`. This is a clean, minimal surface. The grader abstraction (`Grader` interface + `getGrader` factory) is similarly extensible.

---

## 4. Data Flow Clarity

### 4.1 `[major]` `EvalRunOptions` uses optional fields where a discriminated union would be safer

`src/evalRunner.ts:52-65`:
```typescript
export interface EvalRunOptions {
    instruction?: string;
    conversation?: ResolvedConversation;
    ...
}
```

Both `instruction` and `conversation` are optional, with a runtime check at line 89: `if (!opts.instruction && !opts.conversation) throw`. The config types (`config.types.ts`) already use a proper discriminated union (`ResolvedInstructionTask | ResolvedConversationTask`), but this type information is lost when `commands/run.ts:127-146` constructs `EvalRunOptions` by manually destructuring the resolved task.

This means `evalRunner.ts:208-210` has to re-check `if (!opts.instruction)` despite the fact that the caller already knew the type. The same pattern propagates to `conversationRunner.ts` which receives the conversation object separately.

**Recommendation**: Make `EvalRunOptions` a discriminated union mirroring `ResolvedTask`:
```typescript
type EvalRunOptions = InstructionRunOptions | ConversationRunOptions;
```
This would eliminate the redundant runtime checks and make the data flow type-safe end-to-end.

### 4.2 `[minor]` `LogEntry` is a flat union-by-tag type with many optional fields

`src/types.ts:75-90`: `LogEntry` has 7 possible `type` values but uses a single interface with 12 optional fields. This means any consumer must null-check every field, and the compiler cannot enforce which fields are present for which type.

`src/evalRunner.ts:271-273` accesses `entry.output`, `entry.stdout`, and `entry.stderr` on entries filtered to `agent_result` or `command`, but the type system doesn't narrow these. The `graders/index.ts:111-173` LLM grader manually filters and accesses fields with optional chaining throughout.

**Recommendation**: Define `LogEntry` as a discriminated union with per-type interfaces (e.g., `CommandLogEntry`, `AgentResultLogEntry`, etc.). This would give consumers proper narrowing after filtering by `type`.

### 4.3 `[minor]` Token counts are rough estimates, not labeled as such

`src/evalRunner.ts:48-50`:
```typescript
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
```

This estimate is used to populate `input_tokens` and `output_tokens` in `TrialResult`, which are named as if they are actual token counts. The `reporters/cli.ts:29` displays them as "Total Tokens" without qualification.

**Recommendation**: Either rename the fields to `estimated_input_tokens` / `estimated_output_tokens`, or add a flag like `tokens_estimated: boolean` to the result. This prevents confusion when comparing across runs or agents.

---

## 5. Type Architecture

### 5.1 `[minor]` Three parallel type hierarchies for task/grader configuration

The codebase defines three levels of types for essentially the same data:

1. **User input** (`DefineEvalTaskInput`, `DefineEvalGraderInput`) -- what users write in `eval.ts`
2. **Validated config** (`EvalTaskConfig`, `EvalGraderConfig`) -- after `validateConfig()`
3. **Resolved** (`ResolvedTask`, `ResolvedGrader`) -- after `resolveTask()` reads file contents

Plus an additional **raw** layer (`RawTask`, `RawGrader`) used internally by the validator in `config.ts`.

This is a reasonable progressive-refinement pattern, but the raw types in `config.ts:39-87` are structurally identical to the `DefineEval*Input` types in `config.types.ts:169-217`. The validator converts from `RawTask` to `EvalTaskConfig`, but `defineEval()` in `define-eval.ts:8-45` also converts from `DefineEvalTaskInput` to a raw object and then calls `validateConfig()`, creating a round-trip: typed input -> untyped raw -> validated typed output.

**Recommendation**: Have `defineEval()` construct `EvalTaskConfig` objects directly (it already has all the typed data), skipping the serialize-then-validate step. Keep `validateConfig()` for the YAML/JSON code path where input truly is untyped.

### 5.2 `[nit]` `GraderConfig` vs `EvalGraderConfig` vs `ResolvedGrader` naming inconsistency

- `GraderConfig` (`types.ts:40`) -- used by the grader runtime interface (`Grader.grade()`)
- `EvalGraderConfig` (`config.types.ts:74`) -- the user-facing config
- `ResolvedGrader` (`config.types.ts:160`) -- post-resolution

`GraderConfig` is constructed ad-hoc in `evalRunner.ts:346-356` and `conversationRunner.ts:184-194` by combining fields from `ResolvedGrader` with computed paths. This is a different shape from `EvalGraderConfig` and `ResolvedGrader` despite the similar name. The relationship between these three types is not obvious.

---

## 6. Export Surface (`src/core/index.ts`)

### 6.1 `[minor]` `loadEvalConfig` and `resolveTask` are exported but are internal implementation details

`src/core/index.ts:2` exports `loadEvalConfig` and `resolveTask`. These are used only by `commands/run.ts` and are implementation details of the CLI pipeline. External consumers using `@wix/pathgrade` as a library (via the `"."` export in `package.json`) would receive these functions, but they have no documented use case outside the CLI.

The public API should be `defineEval` (for writing eval configs) and the types needed to write those configs. `loadEvalConfig` exposes internal file-loading mechanics (jiti, path resolution) that users should not need.

**Recommendation**: Remove `loadEvalConfig` and `resolveTask` from `core/index.ts`. If they need to be importable for testing or advanced use, expose them via a separate `@wix/pathgrade/internal` export path.

### 6.2 `[nit]` `package.json` `main` and `types` fields point to `pathgrade.ts`, not `core/index.ts`

`package.json:8-9`:
```json
"main": "dist/pathgrade.js",
"types": "dist/pathgrade.d.ts",
```

But the `"exports"` field (line 8-16) points `"."` to `dist/core/index.js`. In modern Node.js, `exports` takes precedence, but older bundlers or tools that read `main`/`types` would get the CLI entry point (`pathgrade.ts`) instead of the library API. This is a potential source of confusion.

**Recommendation**: Align `main` and `types` with the `exports["."]` target, or point them to a re-export barrel that matches the public API.

### 6.3 `[nit]` `GraderOutput` and `GraderCheck` types are exported from `core/index.ts` but defined in `types.ts`

`src/core/index.ts:23` re-exports `GraderOutput` and `GraderCheck` from `../types`. These are the JSON contract types for grader script authors. This is a good design choice -- it gives grader authors a clean import path (`import type { GraderOutput } from '@wix/pathgrade'`) without exposing the full `types.ts` surface.

---

## 7. Additional Observations

### 7.1 `[minor]` Duplicate timeout utilities

`src/evalRunner.ts:21-32` defines a local `withTimeout` function that wraps a promise with a timer-based timeout. `src/utils/timeout.ts` provides `withAbortTimeout` which does the same thing but also provides an `AbortSignal` for cooperative cancellation. Both are used in `evalRunner.ts` -- `withAbortTimeout` for the agent (line 223), `withTimeout` for graders (line 359).

The grader timeout at line 359 does not pass an abort signal, so if a grader hangs, the promise rejection won't actually kill the underlying process -- it just races the timer. The agent path handles this correctly via `withAbortTimeout` + signal propagation.

**Recommendation**: Use `withAbortTimeout` for graders too, and thread the signal through to `provider.runCommand` in the grader. This would make grader timeouts actually kill stuck processes rather than just racing them.

### 7.2 `[minor]` `LocalProvider.setup()` returns `TrialRuntime` but the interface declares `EnvironmentHandle`

`src/types.ts:230`: The `EnvironmentProvider.setup()` return type is `Promise<EnvironmentHandle>` (which is `string | TrialRuntime`). `LocalProvider.setup()` at `src/providers/local.ts:18` always returns a `TrialRuntime` object. This works because `TrialRuntime` is assignable to `EnvironmentHandle`, but callers lose the narrower type information and must work with the union.

This is related to finding 3.2 above -- narrowing `EnvironmentHandle` to `TrialRuntime` would fix both.

---

## Summary

| Severity | Count | Key themes |
|----------|-------|------------|
| Critical | 0 | -- |
| Major | 4 | Scattered grader path conventions, `createAgentSession` type safety, `run.ts` size, `EvalRunOptions` union |
| Minor | 8 | Duplicated LLM logic in init, `LogEntry` flat union, token estimate naming, export surface leaks, timeout inconsistency |
| Nit | 5 | Clean dependency graph, good agent extensibility, naming inconsistencies |

The codebase has a clean overall architecture with good separation between layers. The most impactful improvements would be: (1) extracting the grader path conventions into a shared module, (2) making `EvalRunOptions` a discriminated union to preserve type information through the pipeline, and (3) cleaning up `createAgentSession` to eliminate `as any` casts.
