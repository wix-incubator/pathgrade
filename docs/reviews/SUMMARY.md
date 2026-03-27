# Pathgrade Code Review Summary

**Date**: 2026-03-26
**Commit**: `8eb5d1f` (main)
**Reviewers**: 7 parallel agents covering architecture, security, error handling, testing, developer experience, code quality, and reliability

---

## Finding Counts by Severity

| Review Area                  | Critical | Major | Minor | Nit | Total |
|------------------------------|----------|-------|-------|-----|-------|
| Architecture & Module Design | 0        | 4     | 8     | 5   | 17    |
| Security & Isolation         | 2        | 4     | 7     | 2   | 15    |
| Error Handling & Edge Cases  | 2        | 7     | 8     | 3   | 20    |
| Testing Quality & Coverage   | 3        | 7     | 8     | 1   | 19    |
| Public API & Developer UX    | 2        | 4     | 7     | 5   | 18    |
| Code Quality & Consistency   | 0        | 5     | 9     | 6   | 20    |
| Reliability & Resources      | 2        | 6     | 6     | 3   | 17    |
| **Totals**                   | **11**   | **37**| **53**| **25**| **126** |

---

## Top 5 Most Critical Findings

### 1. No SIGINT/SIGTERM handler -- zombie processes and orphan temp dirs on Ctrl+C
**Flagged by**: Reliability #1, Error Handling #4
**Files**: `src/pathgrade.ts:152-155`, `src/providers/local.ts:143`

The entire codebase has zero signal handlers. Pressing Ctrl+C during a `--regression` run (30 trials, `--parallel=4`) leaves up to 4 orphaned agent process trees (spawned with `detached: true`) consuming API tokens, plus abandoned temp directories containing workspace copies. No cleanup runs -- `provider.cleanup()` is in a `finally` block that never executes on SIGINT.

### 2. Shell command injection via unsanitized `sessionId`
**Flagged by**: Security #1
**File**: `src/agents/claude.ts:42`

The Claude adapter interpolates `sessionId` directly into a shell command (`--resume ${sessionId}`) without validation. The session ID is parsed from agent stdout via a greedy regex (`/\{[\s\S]*\}/`) that could match crafted agent output. Combined with `spawn(..., { shell: true })` in `local.ts:141`, this is a command injection vector. All three agent adapters also embed base64-encoded instructions in shell strings -- safe today but fragile.

### 3. `process.env` leaked to agent and grader child processes in isolated mode
**Flagged by**: Security #3, Security #4
**Files**: `src/providers/local.ts:72-90`, `src/providers/local.ts:145`

Even in `'isolated'` auth mode, `process.env` is spread as the base environment for spawned processes. The isolated env overrides `HOME` and XDG dirs but all env-var secrets (`ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN`, etc.) are directly accessible to agents running with `--dangerously-skip-permissions`. Grader scripts also inherit the full env.

### 4. `conversationRunner.ts` (495 lines, most complex module) has zero dedicated tests
**Flagged by**: Testing #1.1
**File**: `src/conversationRunner.ts`

Multi-turn conversation orchestration -- including signal-based completion, `done_when` LLM judge, pattern-matched replies, persona retry logic, step graders, and per-turn error handling -- is completely untested in isolation. The only coverage is indirect through `evalRunner.test.ts`, which exercises a fraction of the paths. This is the module most likely to have subtle bugs.

### 5. README examples, templates, and `init` output all omit the required `type` field
**Flagged by**: Developer Experience #1
**Files**: `README.md:91-117`, `templates/eval.ts.template:11-37`, `src/commands/init.ts:178-205, 302-344`

Every entry point for new users produces a broken eval.ts. The `type: 'instruction' | 'conversation'` field is required at both the TypeScript and runtime validation level, but is missing from the README example, the scaffolding template, the LLM generation prompt, and the inline fallback template. Users hit an immediate validation error with no obvious fix.

---

## Cross-Cutting Concerns

These findings were independently flagged by 2+ reviewers, indicating systemic issues:

### A. Grader timeout doesn't kill child processes (4 reviewers)
**Architecture** #7.1 | **Error Handling** #2 | **Code Quality** #2 | **Reliability** #3

`evalRunner.ts` uses a local `withTimeout` (timer-race only) for graders, while using `withAbortTimeout` (with AbortSignal) for agents. The grader timeout rejects the promise but the underlying shell process keeps running. On a 30-trial run with hung graders, this accumulates zombie processes. The fix is straightforward: use `withAbortTimeout` for graders too and thread the signal to `provider.runCommand`.

### B. `createAgentSession` uses 5 `as any` casts for duck-typing (3 reviewers)
**Architecture** #3.1 | **Code Quality** #1 | **Testing** #2.2

The function at `types.ts:168-197` runtime-checks whether agents implement `createSession()` vs `run()` using `as any` casts and prototype comparison. All three concrete agents override `createSession` directly, making the `run()` fallback dead code. The duck-typing also means test mocks bypass the real dispatch logic. Fix: make `createSession` the sole contract and remove the `run()` fallback.

### C. Duplicate LLM API call logic (3 reviewers)
**Architecture** #1.1 | **Code Quality** #4 | **Developer Experience** (implicit)

`commands/init.ts` contains ~80 lines of hand-rolled fetch calls to Gemini/Anthropic/OpenAI that duplicate `utils/llm.ts`. The `init.ts` version lacks CLI-first fallback, provider inference, and `OPENAI_BASE_URL` support. A change to any API contract requires updating both locations independently.

### D. Greedy JSON regex matching across 5+ files (3 reviewers)
**Security** #8 | **Error Handling** #11 | **Testing** #4.4

The pattern `stdout.match(/\{[\s\S]*\}/)` is used in `claude.ts:64`, `graders/index.ts:40,228`, `cli-llm.ts:102`, and `conversationRunner.ts:154`. It matches from the **first** `{` to the **last** `}`, which can capture agent-controlled content mixed with real JSON envelopes. This is both a correctness issue (wrong parse) and a security issue (agent can influence parsed data).

### E. `resolveFileOrInline` path/content ambiguity (3 reviewers)
**Error Handling** #10 | **Security** #15 | **Developer Experience** #6

A single-line instruction matching an existing filename silently reads the file instead of using the literal string. No escape hatch exists. Combined with no path traversal check, `../../etc/hostname` as an instruction would read that file.

### F. Path traversal in workspace mappings and browser preview (3 reviewers)
**Security** #5, #6 | **Code Quality** #10 | **Reliability** #11

Workspace `src` mappings and grader file references in `commands/run.ts` have no containment check -- `../../sensitive-dir` escapes the project. The browser preview's `/api/report?file=` endpoint similarly allows directory traversal. None validate that resolved paths stay within the expected root.

### G. Duplicate grader path conventions scattered across 3 files (3 reviewers)
**Architecture** #2.2 | **Code Quality** #12 | **Error Handling** (implicit)

The `.pathgrade/tests/test.sh` and `.pathgrade/prompts/quality.md` naming conventions are hardcoded identically in `commands/run.ts`, `evalRunner.ts`, and `conversationRunner.ts`. The index-to-filename mapping (`test.sh` for 0, `test_N.sh` for N>0) is replicated in all three. A single shared module would eliminate this.

### H. GeminiAgent and CodexAgent are ~90% identical (2 reviewers)
**Code Quality** #3 | **Architecture** (implicit)

The two agents share identical session management, transcript accumulation, `buildTranscriptPrompt`, and prompt-writing patterns. Only the CLI command string and an optional auth step differ. Extracting a shared `CliAgent` base would eliminate ~60 lines of duplication.

### I. `package.json` `main`/`types` conflict with `exports` (2 reviewers)
**Architecture** #6.2 | **Developer Experience** #3

`main` points to the CLI entry (`dist/pathgrade.js`) while `exports["."]` points to the library (`dist/core/index.js`). Older tooling or `moduleResolution: "node"` falls back to `main`, giving consumers the CLI script instead of `defineEval`.

### J. Workspace `dest` and `chmod` fields silently ignored (2 reviewers)
**Developer Experience** #2 | **Security** #5

The type system accepts `dest` and `chmod` on workspace mappings, and the README shows examples using them, but the implementation uses `path.basename(w.src)` and never applies `chmod`. Users who specify custom destinations get silent misbehavior.

---

## Review Files

| Review | File |
|--------|------|
| Architecture & Module Design | [`docs/reviews/architecture.md`](architecture.md) |
| Security & Isolation | [`docs/reviews/security.md`](security.md) |
| Error Handling & Edge Cases | [`docs/reviews/error-handling.md`](error-handling.md) |
| Testing Quality & Coverage | [`docs/reviews/testing.md`](testing.md) |
| Public API & Developer Experience | [`docs/reviews/developer-experience.md`](developer-experience.md) |
| Code Quality & Consistency | [`docs/reviews/code-quality.md`](code-quality.md) |
| Reliability & Resource Management | [`docs/reviews/reliability.md`](reliability.md) |
