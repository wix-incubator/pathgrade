# Code Quality & Consistency Review

**Date**: 2026-03-26
**Scope**: Readability, maintainability, and consistency across the pathgrade codebase
**Files reviewed**: 27 source files in `src/`

---

## Critical

_(none found)_

## Major

### 1. `[major]` `as any` casts in `createAgentSession` bypass type safety

**File**: `src/types.ts:174-182`

The `createAgentSession` function uses five `as any` casts to duck-type method detection on the agent. Since `BaseAgent` is an abstract class that all agents extend, and every agent already implements `createSession()`, this runtime duck-typing is unnecessary and defeats the type checker.

```ts
if (
    typeof (agent as any).createSession === 'function' &&
    (agent as any).createSession !== BaseAgent.prototype.createSession
) {
    return await (agent as any).createSession(runtime, runCommand);
}
```

**Suggestion**: Since all concrete agents (`ClaudeAgent`, `GeminiAgent`, `CodexAgent`) override `createSession`, simplify to `return agent.createSession(runtime, runCommand)` and remove the `run()` fallback path, or make `createSession` the only required method on `BaseAgent` (dropping the abstract `run()`).

### 2. `[major]` Duplicate `withTimeout` / `withAbortTimeout` -- two timeout utilities doing similar things

**Files**: `src/evalRunner.ts:21-32` and `src/utils/timeout.ts:9-42`

`evalRunner.ts` defines a local `withTimeout` (promise-race style) while `src/utils/timeout.ts` exports `withAbortTimeout` (AbortController style). Both are used in `evalRunner.ts` -- `withAbortTimeout` for agent execution and `withTimeout` for grader execution. The grader call does not get an `AbortSignal`, so it cannot propagate cancellation to child processes on timeout -- the grader process keeps running.

**Suggestion**: Unify on `withAbortTimeout` for both agent and grader timeouts. This ensures grader subprocesses receive abort signals and are cleaned up properly.

### 3. `[major]` Duplicate agent adapter logic in `GeminiAgent` and `CodexAgent`

**Files**: `src/agents/gemini.ts:1-60` and `src/agents/codex.ts:1-64`

These two agents are nearly identical. They share:
- The same `createSession` structure with transcript accumulation (lines 4-17 in both)
- The same `run` method signature and body
- An identical `buildTranscriptPrompt` method (lines 29-34 in both)
- The same `runTurn` prompt-writing pattern (base64 encode, write to temp file)

The only differences are: (a) Codex seeds API key auth before the first turn, and (b) the CLI command string.

**Suggestion**: Extract a shared `CliAgent` base class (or a `createCliSession` helper) that handles transcript management, prompt writing, and the shared `run()` method. Each agent subclass would only specify its CLI invocation command and optional pre-turn setup.

### 4. `[major]` Duplicate LLM API call logic in `init.ts` vs `utils/llm.ts`

**Files**: `src/commands/init.ts:220-299` and `src/utils/llm.ts:97-261`

`generateWithLLM` in `init.ts` manually constructs fetch calls to Gemini, Anthropic, and OpenAI APIs -- the same three providers that `callLLM` in `utils/llm.ts` already handles. This is ~80 lines of duplicated HTTP logic with slightly different error handling.

**Suggestion**: Replace `generateWithLLM` with a call to `callLLM` (passing `temperature: 0.3` and the appropriate model). This removes the duplicate fetch logic and ensures both paths benefit from future improvements (e.g., retry logic, rate limiting).

### 5. `[major]` Duplicate grader resolution logic in `config.ts`

**File**: `src/core/config.ts:320-336` and `src/core/config.ts:399-414`

The grader resolution pattern (checking `g.type === 'deterministic' && g.run` then calling `resolveFileOrInline`, and the same for `llm_rubric` and `g.rubric`) appears twice -- once in `resolveTask` for top-level graders and once in `resolveConversation` for step graders.

**Suggestion**: Extract a `resolveGrader(g: EvalGraderConfig, baseDir: string): Promise<ResolvedGrader>` helper and call it from both locations.

---

## Minor

### 6. `[minor]` Unused import: `trialRow` in `run.ts`

**File**: `src/commands/run.ts:17`

`trialRow` is imported but never called anywhere in `run.ts`. The trial output is now handled by the `Spinner` class within `EvalRunner`.

### 7. `[minor]` `getAgentNames()` is only used internally in `registry.ts`

**File**: `src/agents/registry.ts:23-25`

`getAgentNames()` is exported but only called from `createAgent` in the same file (line 31). It is not imported elsewhere. If it is part of the public API for future use, this is fine; otherwise, it could be unexported.

### 8. `[minor]` `BaseAgent.run()` is abstract but redundant with `createSession()`

**File**: `src/types.ts:199-208`

`BaseAgent` declares both `createSession()` and the abstract `run()`. Every concrete agent implements `createSession()` and provides a `run()` that just delegates to `runTurn`. The `run()` method exists only to support the duck-typing fallback in `createAgentSession` (finding #1). If the `as any` fallback is removed, `run()` can be dropped from the interface.

### 9. `[minor]` `LocalProvider.setup` returns `TrialRuntime` but interface declares `EnvironmentHandle`

**File**: `src/providers/local.ts:18` vs `src/types.ts:230`

`LocalProvider.setup()` declares its return type as `Promise<TrialRuntime>`, while the `EnvironmentProvider` interface declares `Promise<EnvironmentHandle>`. This works because `TrialRuntime` is assignable to `EnvironmentHandle`, but the mismatch makes the code harder to follow. The reader has to check that `TrialRuntime` is one arm of the `EnvironmentHandle` union.

**Suggestion**: Either make the return type match the interface (`Promise<EnvironmentHandle>`) or narrow the interface itself.

### 10. `[minor]` Path traversal risk in browser preview API

**File**: `src/reporters/browser.ts:24-33`

The `/api/report` endpoint reads a `file` query parameter and joins it directly to `resultsDir` without sanitization:

```ts
const file = url.searchParams.get('file');
const filePath = path.join(resolved, file);
```

A request like `?file=../../etc/passwd` would escape the results directory. This is a local dev server, so the risk is low, but it is still a defect.

**Suggestion**: Validate that the resolved path starts with the results directory, e.g.:
```ts
if (!filePath.startsWith(resolved)) { res.writeHead(403); res.end(); return; }
```

### 11. `[minor]` Gemini API key leaked in URL query parameter

**File**: `src/utils/llm.ts:103` and `src/commands/init.ts:278`

Both places pass the Gemini API key as a URL query parameter:
```ts
const url = `https://...?key=${apiKey}`;
```

This means the key will appear in any error messages, stack traces, or debug logs that include the URL. The Anthropic and OpenAI calls send keys in headers, which is safer.

**Suggestion**: This is Gemini's documented API pattern, so it cannot be easily changed, but consider redacting the URL in error messages (the `errBody` already truncates, but the URL itself is in the `fetch` call).

### 12. `[minor]` Grader config construction duplicated between `evalRunner.ts` and `conversationRunner.ts`

**Files**: `src/evalRunner.ts:346-356` and `src/conversationRunner.ts:184-194`

Both files construct `graderConfig` objects with the same pattern of mapping `detIndex`/`llmIndex` to file paths like `.pathgrade/tests/test.sh` and `.pathgrade/prompts/quality.md`. The path-construction logic (including the `index === 0 ? 'test.sh' : 'test_N.sh'` convention) is repeated.

**Suggestion**: Extract a `buildGraderConfig(graderDef, index, opts)` helper.

### 13. `[minor]` Prompt-writing pattern duplicated across all three agents

**Files**: `src/agents/claude.ts:37-38`, `src/agents/gemini.ts:43-44`, `src/agents/codex.ts:47-48`

All three agents use the same base64-encode-and-write-to-temp-file pattern:
```ts
const b64 = Buffer.from(instruction).toString('base64');
await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);
```

This is duplicated three times verbatim.

**Suggestion**: Extract to a shared utility like `writePromptToTempFile(instruction, runCommand)`.

### 14. `[minor]` `LogEntry` is a flat union type using optional fields instead of discriminated union

**File**: `src/types.ts:75-90`

`LogEntry` has a `type` discriminant field but all other fields are optional on a single interface. This means any code accessing `entry.instruction` or `entry.command` must do manual existence checks even when `entry.type === 'agent_start'` guarantees `instruction` is present. A discriminated union with per-type interfaces would give better type narrowing.

---

## Nits

### 15. `[nit]` Empty line at line 378 in `conversationRunner.ts`

**File**: `src/conversationRunner.ts:378`

There is an extra blank line between `const durationMs` and `turns.push(...)`.

### 16. `[nit]` Inconsistent error type assertion pattern

Multiple files use `(error as Error).message` or `(error as Error)?.message` to access the error message. This is done differently across files:
- `src/evalRunner.ts:293`: `(error as Error)?.message || String(error)`
- `src/conversationRunner.ts:458`: `(err as Error)?.message || String(err)`
- `src/commands/init.ts:78`: `(err as Error).message` (no fallback)
- `src/core/config.ts:111`: `(e as Error).message` (no fallback)

**Suggestion**: Standardize on a helper like `getErrorMessage(err: unknown): string` for consistency and null-safety.

### 17. `[nit]` `fmt.dim('note:')` vs `fmt.red('error')` vs `fmt.red('warning')` -- inconsistent diagnostic prefix style

**Files**: `src/commands/run.ts:86` uses `fmt.dim('note:')`, `run.ts:70` uses `fmt.red('warning')`, and `run.ts:86-88` uses `fmt.red('error')`.

These are fine individually, but a `fmt.warn()` / `fmt.note()` helper would make the pattern more consistent.

### 18. `[nit]` Nested ternary in `resultsSummary`

**File**: `src/utils/cli.ts:59-62`

```ts
const presetLabel = preset === 'smoke' ? ' (smoke test)'
    : preset === 'reliable' ? ' (reliable)'
        : preset === 'regression' ? ' (regression)'
            : '';
```

A `switch` or lookup map would be clearer.

### 19. `[nit]` `callLLM` in `conversationRunner.ts` is imported but only used inside `checkCompletion`

**File**: `src/conversationRunner.ts:19`

The import `callLLM` is valid and used, but it is only called deep inside `checkCompletion`. If `checkCompletion` were extracted to its own module (which its complexity might warrant), the import would move with it.

### 20. `[nit]` `process.env.OPENAI_BASE_URL` checked in two places with different defaults

**Files**: `src/commands/run.ts:52` forwards `OPENAI_BASE_URL` into the env bag, while `src/utils/llm.ts:180` reads it from both `env` and `process.env` with a fallback to `'https://api.openai.com/v1'`. The `init.ts:255-268` OpenAI call does NOT check `OPENAI_BASE_URL` at all, so init-generated evals will always hit the public API even if a custom base URL is configured.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| Major    | 5     |
| Minor    | 9     |
| Nit      | 6     |

**Key themes**:
1. **Duplication** is the dominant issue. The agent adapters, LLM API call paths, grader config construction, and grader resolution logic all have near-identical copies that should be unified.
2. **Type safety** is generally good after the recent `any` cleanup, but the `createAgentSession` duck-typing in `types.ts` is the remaining significant `as any` hotspot.
3. **Consistency** across files is high -- the same patterns (spinner, fmt, fs-extra) are used throughout. The main inconsistencies are in error handling patterns and timeout utilities.
