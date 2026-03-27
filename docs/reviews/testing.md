# Testing Quality & Coverage Review

**Date**: 2026-03-26
**Scope**: All test files and their corresponding source files in pathgrade

---

## 1. Coverage Gaps

### 1.1 `conversationRunner.ts` has NO dedicated test file

`[critical]` The file `src/conversationRunner.ts` (495 lines) is the most complex module in the codebase. It manages multi-turn conversation loops, reply selection (scripted vs. pattern vs. persona), completion detection (signal, done_phrase, done_when, max_turns), step graders, and timeout handling. There is no `tests/conversationRunner.test.ts` file. The only coverage comes indirectly through `tests/evalRunner.test.ts`, which tests a handful of conversation scenarios via the full `EvalRunner` stack.

**What is not covered at all:**
- `workspaceHasSignal()` -- the `signal` completion path including glob matching (`src/conversationRunner.ts:76-101`)
- `checkCompletion()` with `done_when` (LLM judge path) (`src/conversationRunner.ts:131-164`)
- `pickReply()` pattern matching via `when` regex (`src/conversationRunner.ts:226-228`)
- `pickReply()` persona retry-on-failure logic (the 2-attempt loop at `src/conversationRunner.ts:245-268`)
- `pickReply()` returning `null` to end conversation with `no_replies` reason
- The per-turn error/timeout catch block (`src/conversationRunner.ts:456-493`)
- `normalizeAssistantMessage()` fallback to rawOutput when assistantMessage is empty (`src/conversationRunner.ts:68-74`)
- Step graders running after each turn (`src/conversationRunner.ts:169-211`)

### 1.2 `src/persona.ts` has no tests

`[major]` `src/persona.ts` contains `buildPersonaPrompt()` and `generatePersonaReply()`. The prompt-building logic (`buildTranscript`, the full prompt template) is never directly tested. Persona behavior is only tested indirectly in `evalRunner.test.ts:181-282` via fetch mocking, but the prompt structure itself is verified there by checking string contents of the captured request body rather than testing the module directly. If `buildPersonaPrompt` changes, those assertions could silently pass while the prompt breaks.

### 1.3 `src/utils/llm.ts` provider-fallback logic is lightly tested

`[major]` `tests/llm-fallback.test.ts` only tests the CLI-first path of `callLLM()`. The API-key fallback chain (`callGemini`, `callAnthropic`, `callOpenAI`) is exercised through `tests/graders.test.ts` but those tests call `LLMGrader.grade()` rather than `callLLM()` directly. The LLM grader tests mock `globalThis.fetch` inline, so they are actually testing the real `callLLM` code path. However, the following is untested:
- `inferProviderFromModel()` for all model prefix variations (`gpt-`, `chatgpt-`, `o1`, `o3`, `o4`) (`src/utils/llm.ts:50-66`)
- `getProviderSequence()` when a specific model is requested but its key is missing (`src/utils/llm.ts:83-85`)
- `callOpenAI` with a custom `OPENAI_BASE_URL` (`src/utils/llm.ts:180`)

### 1.4 `src/utils/timeout.ts` -- `withAbortTimeout` has no tests

`[minor]` This utility wraps async functions with abort signals and is critical to the timeout path for both agents and conversations. It is exercised indirectly by `evalRunner.test.ts:368-399` but not tested in isolation. Edge cases like the resolve-after-abort path (`src/utils/timeout.ts:26-28`) where `timedOut` is already true when the promise resolves are not verified.

### 1.5 `src/reporters/browser.ts` has no tests

`[minor]` The browser preview server has no test coverage. It is a small HTTP server, but it has routing logic (`/api/reports`, `/api/report?file=...`, and HTML serving) and security-sensitive behavior (serving file contents from disk based on query parameter).

### 1.6 `src/agents/registry.ts` has no dedicated tests

`[minor]` `createAgent()` and `getAgentNames()` are not directly tested. They are simple factory functions but the error path for unknown agent names (`src/agents/registry.ts:31`) is never exercised in tests. The function is only tested indirectly through mocks in `run.local-first-runtime.test.ts`.

### 1.7 `src/pathgrade.ts` CLI entrypoint has no tests

`[minor]` The CLI argument parsing and dispatch logic in the entrypoint is untested beyond the surface-level checks in `cli-surface-local-first.test.ts` (which just checks `--help` output).

---

## 2. Mock Fidelity Issues

### 2.1 `evalRunner.test.ts` mocks `getGrader` via spyOn-after-import but the file also has a top-level `vi.mock('./graders')`

`[major]` At `tests/evalRunner.test.ts:11-13`, there is a `vi.mock('./graders')` with path `./graders` (relative), but the actual import path from `evalRunner.ts` is `./graders` (correct relative to the source). However, every test then also does `vi.spyOn(gradersModule, 'getGrader')` after a dynamic import (`tests/evalRunner.test.ts:88-89`). The top-level mock at line 11 uses a relative path from the test file, not from the source file, which means it may not intercept the import correctly depending on the test runner's module resolution. The fact that each test re-spies the module suggests this may have been a workaround for the top-level mock not working. This fragile double-mocking pattern could silently break if vitest's module resolution changes.

### 2.2 Agent mocks in `evalRunner.test.ts` do not test the `createAgentSession` dispatch

`[major]` The `makeMockAgent()` helper at `tests/evalRunner.test.ts:68-72` creates an agent with only a `run` method. The real `createAgentSession` in `src/types.ts:168-197` has complex dispatch logic: it checks if `createSession` exists AND is not the same as `BaseAgent.prototype.createSession`, then falls back to `run`. The mock bypasses this by passing objects that satisfy the duck-type check. If the dispatch logic in `createAgentSession` has a bug, these tests would not catch it.

### 2.3 `commands.init.test.ts` duplicates private functions instead of testing through the public API

`[major]` `tests/commands.init.test.ts:8-30` re-implements `extractInstructionHint` and `tests/commands.init.test.ts:81-113` re-implements `getInlineTemplate` from `src/commands/init.ts`. These are copy-pasted implementations, meaning the tests verify the copy, not the actual source code. If the source function changes, the tests still pass. The actual `runInit()` function is never called in these tests.

**Recommendation**: Either export these helper functions for direct testing, or test them through `runInit()` with appropriate mocks.

### 2.4 `graders.test.ts` fetch mocks lack `ok` and `text` on some paths

`[minor]` Most fetch mocks in `tests/graders.test.ts` properly include `ok: true` and `text()` method, but this was apparently a prior bug (per commit `b94b5d1`). The current state looks correct, but the pattern of manually mocking `globalThis.fetch` and restoring it in a `finally` block (e.g., `tests/graders.test.ts:194-215`) is fragile -- if a test throws before the `finally`, subsequent tests could use the wrong fetch. Using `beforeEach`/`afterEach` for cleanup would be more robust.

### 2.5 LLMGrader tests go through the real `callLLM` code path but `graders/index.ts` does not call `callLLM`

`[minor]` The `LLMGrader.grade()` method at `src/graders/index.ts:206` calls `callLLM()` which is the centralized LLM utility. However, the test mocks at `tests/graders.test.ts:12-14` mock `cli-llm` to disable CLI availability but do NOT mock `callLLM`. Instead, they mock `globalThis.fetch`. This means the tests exercise the full `callLLM -> callGemini/callAnthropic/callOpenAI -> fetch` chain, which is actually good for integration coverage. However, the mock at line 12-14 (`vi.mock('../src/utils/cli-llm')`) means the CLI-first path of `callLLM` is silently disabled. This is intentional but undocumented in the test file -- a comment would help future maintainers understand why.

---

## 3. Assertion Quality Issues

### 3.1 `evalRunner.test.ts:98` uses `toBeGreaterThan(0)` for session log length

`[minor]` At `tests/evalRunner.test.ts:98`:
```ts
expect(report.trials[0].session_log.length).toBeGreaterThan(0);
```
This does not verify the expected log structure. The session log should contain specific entries (`agent_start`, `agent_result`, `grader`, `reward`). A more specific assertion like `expect(report.trials[0].session_log.map(e => e.type)).toEqual(['agent_start', 'agent_result', 'grader', 'reward'])` would catch regressions in log ordering or missing entries.

### 3.2 `commands.preview.test.ts` only checks that the right function was called, not the result

`[minor]` All tests in `tests/commands.preview.test.ts` assert that mocked functions were called or not called (`tests/commands.preview.test.ts:31-33`). None of them verify what `runPreview` returns or what side effects it produces. This is adequate for a thin routing layer but worth noting.

### 3.3 `cli-llm.test.ts` skips tests when CLI is unavailable

`[minor]` At `tests/cli-llm.test.ts:18`, `callClaudeCli` tests have `if (!await isClaudeCliAvailable()) return;` which silently skips the test. In CI without Claude CLI installed, these tests always pass vacuously. Consider using `it.skipIf()` or logging a warning so skipped tests are visible in test output.

### 3.4 `evalRunner.test.ts:478-493` parallel trial test has no meaningful assertion

`[minor]` The parallel execution test at `tests/evalRunner.test.ts:478-493` only asserts `expect(report.trials).toHaveLength(3)`. It does not verify that trials actually ran in parallel (e.g., by checking that concurrent setup calls overlapped). The sequential path would also produce 3 trials, so this test would pass even if the parallelism logic was entirely broken.

---

## 4. Edge Case Coverage Gaps

### 4.1 Weighted grader score calculation is untested for edge cases

`[critical]` The reward calculation at `src/evalRunner.ts:373-377`:
```ts
const totalWeight = graderResults.reduce((sum, result) => sum + result.weight, 0);
const reward = totalWeight > 0
    ? graderResults.reduce((sum, result) => sum + result.score * result.weight, 0) / totalWeight
    : 0;
```
No test verifies the weighted average calculation with different weights. The test at `tests/evalRunner.test.ts:551-574` uses 3 graders with different weights (0.5, 0.2, 0.3) but the mock returns the same score and weight for all three (the mock ignores the config weight and always returns `weight: 1.0`), defeating the purpose of testing weighted scoring. The mock at line 564-567 returns `{ score: 1.0, weight: 1.0, details: 'ok' }` regardless of which grader config was passed.

### 4.2 `calculatePassAtK` and `calculatePassPowK` are not tested for edge cases

`[major]` `src/evalRunner.ts:34-46` has two statistical functions. `calculatePassAtK` has a boundary check `if (n - c < k) return 1.0` and a combinatorial loop. These are never tested directly. Only `calculatePassAtK(2, 1, 2)` is tested indirectly via `tests/evalRunner.test.ts:452-476`. Edge cases like k=0, n=0, c=0, c=n, and k>n are not tested. The pass_pow_k function (simple exponentiation) would fail with n=0 (division by zero producing NaN).

### 4.3 Grader timeout is untested

`[major]` At `src/evalRunner.ts:358-363`, grader execution is wrapped in `withTimeout()`. No test verifies what happens when a grader times out. The `graderTimeoutSec` option is never tested.

### 4.4 `DeterministicGrader` -- JSON embedded in other stdout content

`[minor]` The regex `result.stdout.match(/\{[\s\S]*\}/)` at `src/graders/index.ts:40` will match the last `}` in stdout, which could include non-JSON output. For example, stdout `"Running tests...\n{score: 0.5}\nDone {ok}"` would capture `{score: 0.5}\nDone {ok}` and fail to parse. No test covers stdout with mixed content where JSON is embedded among other output.

### 4.5 No tests for the `EvalRunOptions` validation guard

`[minor]` `src/evalRunner.ts:89-91` throws when neither `instruction` nor `conversation` is provided. This validation is untested.

### 4.6 `sanitize()` does not redact short secrets (length <= 5)

`[nit]` At `src/evalRunner.ts:390`, secrets shorter than 6 characters are skipped. This is a deliberate design choice to avoid false positives, but no test documents this behavior.

---

## 5. Test Isolation Issues

### 5.1 `graders.test.ts` mutates `process.env` and relies on `finally` for cleanup

`[major]` Multiple tests in `tests/graders.test.ts` (e.g., lines 158-174, 288-309) delete keys from `process.env` and restore them in `finally` blocks. If any assertion throws before the `finally`, the env vars remain deleted for subsequent tests. Tests at lines 283-309 and 334-365 also save/restore `process.env.GEMINI_API_KEY` but use conditional restoration (`if (origGemini)`) that fails to restore the key if it was originally undefined but set during the test.

More critically, these tests also mutate `globalThis.fetch` (e.g., `tests/graders.test.ts:195`) and restore in `finally`. If the test times out or an unexpected error occurs before `finally`, `fetch` stays mocked for all subsequent tests.

**Recommendation**: Use `vi.stubGlobal` with `afterEach(vi.unstubAllGlobals)` for fetch mocking, and `vi.stubEnv`/`vi.restoreAllEnvs` for env manipulation.

### 5.2 `evalRunner.test.ts` has the same `globalThis.fetch` mutation pattern

`[major]` Tests at `tests/evalRunner.test.ts:209-281` and `tests/evalRunner.test.ts:312-353` manually save and restore `globalThis.fetch`. Same risk as 5.1.

### 5.3 `agents.test.ts` mutates `process.env.OPENAI_API_KEY`

`[minor]` At `tests/agents.test.ts:223-246`, the CodexAgent test sets `process.env.OPENAI_API_KEY = 'sk-test-key'` and restores in `finally`. Using `vi.stubEnv` would be safer.

---

## 6. Integration Gaps

### 6.1 No end-to-end test of the full eval pipeline

`[critical]` There is no test that runs the actual `runEvals()` command (from `src/commands/run.ts`) with a real `LocalProvider`, a real (or realistic) agent mock, and real filesystem operations. The test at `tests/run.local-first-runtime.test.ts` mocks every dependency (`loadEvalConfig`, `resolveTask`, `detectSkills`, `createAgent`, `LocalProvider`, `EvalRunner`), so it is effectively testing the wiring between mock boundaries, not the actual behavior.

The closest to integration tests are `tests/providers.local.test.ts` (which tests `LocalProvider` with real filesystem) and `tests/config-ts-loading.test.ts` (which loads real TypeScript config via jiti). But no test chains: load config -> resolve task -> set up workspace -> run agent -> grade results.

### 6.2 Agent CLIs are never tested with real invocations

`[major]` All three agent implementations (`ClaudeAgent`, `GeminiAgent`, `CodexAgent`) mock `runCommand`. The command strings they construct (e.g., `gemini -y --sandbox=none -p "$(cat ...)"`) are verified by string matching but never executed. This is expected for unit tests, but there are no integration tests or smoke tests that validate the CLI commands work with the actual tools.

### 6.3 `loadEvalConfig` with real jiti loading + `resolveTask` is not tested end-to-end

`[minor]` `tests/config-ts-loading.test.ts` tests `loadEvalConfig` with real jiti, and `tests/config.test.ts` tests `resolveTask` with mocked fs. But no test loads a real `eval.ts` file AND then resolves its tasks against real fixture files.

---

## 7. Test Readability

### 7.1 `evalRunner.test.ts` persona test is 100 lines with inline fetch mocking

`[minor]` The test at `tests/evalRunner.test.ts:181-282` ("falls back to persona replies after scripted replies are exhausted") is over 100 lines with deeply nested mock setup, inline fetch mocking, try/finally cleanup, and 15 separate assertions. Extracting the fetch mock setup and persona conversation config into helpers would improve readability.

### 7.2 `run.local-first-runtime.test.ts` uses `vi.hoisted` with 12 mock declarations

`[minor]` The mock setup at `tests/run.local-first-runtime.test.ts:4-31` declares 12 separate mock functions via `vi.hoisted`, then maps them to 6 different module mocks. While this pattern is necessary to control module-level mocking, the sheer number of mocks makes it hard to understand what the test is actually exercising. Consider grouping mocks by module and adding brief comments.

### 7.3 Inconsistent test naming conventions

`[nit]` Some test names describe behavior ("handles agent errors gracefully"), while others describe implementation ("calls provider.diagnose on error if available"). The mixed style is not a problem per se but consistency would improve scannability.

---

## 8. Summary of Prioritized Recommendations

| Priority | Finding | Location |
|----------|---------|----------|
| Critical | No dedicated test file for `conversationRunner.ts` -- the most complex module | `src/conversationRunner.ts` |
| Critical | No end-to-end integration test of the full eval pipeline | `src/commands/run.ts` |
| Critical | Weighted grader score calculation untested due to mock returning fixed weights | `tests/evalRunner.test.ts:551-574`, `src/evalRunner.ts:373-377` |
| Major | `commands.init.test.ts` tests copied functions, not actual source | `tests/commands.init.test.ts:8-30, 81-113` |
| Major | `calculatePassAtK`/`calculatePassPowK` statistical functions untested for edge cases | `src/evalRunner.ts:34-46` |
| Major | Grader timeout path is untested | `src/evalRunner.ts:358-363` |
| Major | `process.env` and `globalThis.fetch` mutation without safe cleanup in graders.test.ts | `tests/graders.test.ts:158-174, 288-309` |
| Major | Same unsafe `globalThis.fetch` mutation in evalRunner.test.ts | `tests/evalRunner.test.ts:209-281` |
| Major | `src/persona.ts` has no dedicated tests | `src/persona.ts` |
| Major | `evalRunner.test.ts` fragile double-mocking of `getGrader` | `tests/evalRunner.test.ts:11-13, 88-89` |
| Minor | `withAbortTimeout` utility untested in isolation | `src/utils/timeout.ts` |
| Minor | `cli-llm.test.ts` silently skips tests when CLI unavailable | `tests/cli-llm.test.ts:18` |
| Minor | Parallel trial test has no meaningful parallelism assertion | `tests/evalRunner.test.ts:478-493` |
| Minor | `src/reporters/browser.ts` has no tests | `src/reporters/browser.ts` |
| Minor | `src/agents/registry.ts` error path untested | `src/agents/registry.ts:31` |
