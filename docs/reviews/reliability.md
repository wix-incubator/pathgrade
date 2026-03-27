# Reliability & Resource Management Review

Reviewed: 2026-03-26
Scope: Process lifecycle, concurrency, resource cleanup, graceful shutdown, report integrity

---

## Critical

### 1. No graceful shutdown handler -- zombie processes and orphan temp dirs on Ctrl+C

`src/pathgrade.ts:152-155`

The top-level `main()` catches errors with `process.exit(1)` but registers no `SIGINT` / `SIGTERM` handler. When the user presses Ctrl+C mid-eval:

- Running agent subprocesses (claude, gemini, codex CLIs) are not killed. Because `local.ts:143` spawns them with `detached: true`, the process group survives the parent's exit, leaving zombie agent processes consuming CPU and API tokens.
- The `provider.cleanup(runtime)` call in `evalRunner.ts:324` never runs, so per-trial temp directories under `$TMPDIR/pathgrade-*` are abandoned.
- The `fs.remove(tmpTaskDir)` in `commands/run.ts:212` never runs either.

There is no process-wide signal handler anywhere in the codebase. With `--regression` (30 trials) and `--parallel=4`, a Ctrl+C could leave up to 4 orphaned agent process trees and 4 uncleaned temp directories.

**Recommendation**: Register a `process.on('SIGINT', ...)` handler that tracks active child processes and runtime handles, kills them, and cleans up temp dirs before exiting.

---

### 2. Parallel trials share a fixed prompt file path -- concurrent corruption

`src/agents/claude.ts:34`, `src/agents/gemini.ts:40`, `src/agents/codex.ts:40`

All three agents write the instruction to a hardcoded path:
```
const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';
```

With `--parallel=N` where N > 1, each trial's workspace has its own TMPDIR (set in `local.ts:79`), so `${TMPDIR}` resolves to a per-trial path. However, when `authMode === 'host'` (line 72-89 of `local.ts`), the runtime env only sets `TMPDIR` to the trial's tmp path. Since the command runs via `spawn(..., { env: { ...process.env, ...env, ...getRuntimeEnv(runtime) } })`, the trial-specific `TMPDIR` should take precedence. BUT: the prompt path uses `${TMPDIR:-/tmp}` which is evaluated by the **shell inside the spawned process**. If the `TMPDIR` env var is correctly forwarded, this works. But the variable is set on the child process env, and the shell string `${TMPDIR:-/tmp}` reads from the child env, so this is safe **only when the env is correctly forwarded to every shell invocation**.

Critically, `cli-llm.ts:139` spawns the claude CLI availability check **without** any trial-specific env -- it uses `{ ...process.env, ...env }` where `env` is an empty `{}`. If a callClaudeCli or callLLM invocation happens concurrently from the conversation runner (e.g., persona reply or done_when check), it would use the **host TMPDIR**, not the trial one. But those code paths write to stdin, not to the prompt file, so this particular race does not occur there.

The real risk: If `$TMPDIR` is unset in the child environment for any reason (env override bug, edge case), all parallel trials would write to `/tmp/.pathgrade-prompt.md` simultaneously, corrupting each other's prompts.

**Recommendation**: Use a unique filename per invocation (e.g., include a random suffix or trial index) rather than relying on TMPDIR isolation.

---

## Major

### 3. `withTimeout` in evalRunner does not kill the underlying work -- agent keeps running after grader timeout

`src/evalRunner.ts:21-32`

The `withTimeout` wrapper used for graders (line 359) only races a `setTimeout` against the promise. When the timeout fires, it rejects the wrapper promise, but the underlying `grader.grade()` call continues executing. For the `DeterministicGrader`, this means the `provider.runCommand()` call continues running the grader script indefinitely because no AbortSignal is passed to it.

Contrast this with `withAbortTimeout` (used for agents at line 223), which properly signals cancellation.

**Recommendation**: Use `withAbortTimeout` for grader execution too, and pass the signal through to `provider.runCommand`.

---

### 4. `cli-llm.ts` timeout SIGKILL follow-up timer is never cleared on normal exit

`src/utils/cli-llm.ts:147-152`

```typescript
const timer = setTimeout(() => {
    if (!settled) {
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 500);
    }
}, timeoutSec * 1000);
```

When the timeout fires and sends SIGTERM, a second 500ms timer is created for the SIGKILL escalation. This inner timer is never assigned to a variable and therefore can never be cleared. If the process exits after SIGTERM but before the 500ms, calling `child.kill('SIGKILL')` on an already-dead process will throw (or silently fail). More importantly, when the normal `close` event fires (line 161), only the outer `timer` is cleared; the inner SIGKILL timer remains live.

This is a minor resource leak but could cause unexpected errors in edge cases where the Node process is shutting down.

**Recommendation**: Track the SIGKILL timer and clear it in the `close`/`error` handlers, similar to the pattern in `local.ts:151-156`.

---

### 5. `cli-llm.ts` does not use process groups -- orphan child processes on timeout

`src/utils/cli-llm.ts:139`

```typescript
const child = spawn(command, args, {
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
});
```

Unlike `local.ts:141-143` which uses `detached: true` and `process.kill(-child.pid, 'SIGTERM')` to kill the entire process group, `cli-llm.ts` spawns without `detached` and sends SIGTERM only to the direct child. If the claude CLI spawns its own subprocesses, those survive the kill.

**Recommendation**: Use `detached: true` and process-group kill like `local.ts` does.

---

### 6. Report writes are not atomic -- crash during `writeJSON` produces corrupt JSON

`src/evalRunner.ts:435`

```typescript
await fs.writeJSON(filePath, report, { spaces: 2 });
```

`fs-extra.writeJSON` writes directly to the target path. If the process crashes mid-write (OOM, SIGKILL, disk full), the file is left in a partially-written state. Subsequent `preview` commands will try to parse it and fail (the `try { ... } catch { continue; }` in `cli.ts:22-23` handles this gracefully for the CLI preview, but `browser.ts:17` would serve corrupt JSON to the browser).

**Recommendation**: Write to a temp file in the same directory, then atomically rename (`fs.move` or `fs.rename`). This is standard practice for file integrity.

---

### 7. Unbounded stdout/stderr accumulation in memory

`src/providers/local.ts:199-200`

```typescript
child.stdout.on('data', (data) => { stdout += data.toString(); });
child.stderr.on('data', (data) => { stderr += data.toString(); });
```

Agent stdout/stderr are concatenated in memory without any size limit. An agent that produces verbose output (e.g., streaming a large file to stdout, or a compilation error with thousands of lines) could cause memory exhaustion. This applies to every command run during a trial, and the outputs are also stored in `sessionLog` entries (`evalRunner.ts:234-236`), which are kept in memory for the entire trial duration.

Similarly in `cli-llm.ts:158-159`, LLM CLI output is accumulated without bound.

For a 30-trial regression run with parallel=4, memory pressure from accumulated logs could be significant.

**Recommendation**: Truncate stdout/stderr at a reasonable limit (e.g., 1MB per stream) with a warning. Consider streaming large outputs to disk instead.

---

### 8. `sessionLog` is passed by reference and mutated across concurrent async operations

`src/conversationRunner.ts:275-310`

The `sessionLog` array is shared and mutated by:
1. The `runCommand` callback (line 310-318) -- pushed to during agent execution
2. The main conversation loop (lines 352, 390, 472)
3. `runStepGraders` (line 201)

While this is single-threaded (Node.js event loop), within a single trial there is no concurrency issue. However, if the `provider.runCommand` callback is invoked concurrently by the agent (e.g., the agent spawns multiple commands in parallel), the `commandCount++` on line 301 and the `.push()` on 302/310 would interleave safely because JavaScript is single-threaded. This is safe but worth noting as an assumption that breaks if the architecture changes.

The more concerning pattern: `currentTurnCommands` (line 291) is reassigned as a closure variable at line 349: `currentTurnCommands = turnCommands`. If a command callback from a previous turn fires late (after abort), it would push to the new turn's command array. This is a subtle data integrity issue.

**Recommendation**: Capture `turnCommands` by value in the callback closure, or use a per-turn identifier to filter late arrivals.

---

## Minor

### 9. Disk space: no cleanup of results directory; grows unbounded

`src/evalRunner.ts:427-436`

Each eval run appends a timestamped JSON report to the results directory. There is no rotation, pruning, or size-limit mechanism. With regular use (especially `--regression` with detailed session logs), the results directory can grow indefinitely.

The default output is `$TMPDIR/pathgrade` (run.ts:93), which OS temp cleanup may eventually reclaim, but users with `--output=./results` will accumulate unbounded data.

**Recommendation**: Document the growth behavior. Consider adding a `--keep=N` flag or automatic pruning of old reports.

---

### 10. GeminiAgent and CodexAgent transcript grows unbounded across conversation turns

`src/agents/gemini.ts:5-12`, `src/agents/codex.ts:5-12`

Both agents implement multi-turn by re-sending the full transcript each turn:
```typescript
const transcript: string[] = [];
const runTranscriptTurn = async (message: string) => {
    transcript.push(`User: ${message}`);
    const result = await this.runTurn(this.buildTranscriptPrompt(transcript), runCommand);
    transcript.push(`Assistant: ${result.assistantMessage}`);
    return result;
};
```

For a long conversation (e.g., 10+ turns with verbose agent output), the base64-encoded prompt grows quadratically. This could hit shell argument limits or agent CLI input limits. It also means the prompt file written to `$TMPDIR` grows large.

**Recommendation**: Add a transcript size limit or summarization strategy for long conversations. At minimum, truncate assistant messages stored in the transcript.

---

### 11. Path traversal in browser preview endpoint

`src/reporters/browser.ts:24-28`

```typescript
const file = url.searchParams.get('file');
const filePath = path.join(resolved, file);
```

The `file` parameter from the query string is joined directly with `resolved` without sanitization. A request like `?file=../../etc/passwd` would construct a path outside the results directory. `path.join` resolves `..` segments.

The preview server is localhost-only and intended for local development, so the practical risk is low. But if the preview port is ever exposed (e.g., via port forwarding in a remote dev environment), this becomes an arbitrary file read.

**Recommendation**: Validate that the resolved path starts with `resolved` using `path.resolve()` and a prefix check.

---

### 12. `withAbortTimeout` can reject after resolve in edge case

`src/utils/timeout.ts:22-40`

```typescript
run(controller.signal).then(
    (val) => {
        clearTimeout(timer);
        if (timedOut || controller.signal.aborted) {
            reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
            return;
        }
        resolve(val);
    },
    ...
);
```

There is a race: the timer fires, sets `timedOut = true`, and calls `controller.abort()`. Concurrently, the `run` promise resolves successfully (it completed just before the abort propagated). In the `.then(val)` handler, `clearTimeout(timer)` is called (no-op, timer already fired), then the check `timedOut || controller.signal.aborted` is true, so it calls `reject()`. This is correct behavior (treating a late success as a timeout). However, the underlying work has already completed and its side effects persist (e.g., commands already executed in the workspace). The timeout is therefore not a clean cancellation -- it is a "give up waiting" semantic.

This is not a bug per se, but it means timeouts do not prevent the agent from completing work in the workspace, which could affect grader results if the grader runs immediately after the timeout rejection.

**Recommendation**: Document that timeout is best-effort and the workspace may be partially modified.

---

### 13. `local.ts` cleanup failure is silently ignored

`src/providers/local.ts:126-131`

```typescript
async cleanup(runtime: EnvironmentHandle): Promise<void> {
    const cleanupPath = getRuntimeHandle(runtime);
    if (await fs.pathExists(cleanupPath)) {
        await fs.remove(cleanupPath);
    }
}
```

If `fs.remove` throws (e.g., permission denied, file locked by a still-running agent process), the error propagates up to `evalRunner.ts:324` inside a `finally` block. An error here would mask the original trial result. The `commands/run.ts:212` cleanup wraps in try/catch, but the per-trial cleanup in evalRunner does not.

**Recommendation**: Wrap `cleanup` in try/catch in `evalRunner.ts:324` to prevent cleanup failures from masking trial results.

---

### 14. Base64 encoding in agent prompt injection is fragile with large payloads

`src/agents/claude.ts:37-38`

```typescript
const b64 = Buffer.from(instruction).toString('base64');
await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);
```

The base64 string is embedded directly in a shell command via string interpolation. For very large instructions (e.g., a long conversation transcript in Gemini/Codex agents), this could exceed the maximum command-line length (`ARG_MAX`, typically 256KB on macOS, 2MB on Linux). The instruction is already large for multi-turn conversation agents since the entire transcript is included.

**Recommendation**: Write the base64 data to a file first (e.g., via `fs.writeFile` on the host side), then have the shell command read from that file.

---

## Nit

### 15. Parallel trial queue uses array shift without synchronization

`src/evalRunner.ts:155-158`

```typescript
const workers = Array.from({ length: Math.min(parallel, numTrials) }, async () => {
    while (queue.length > 0) {
        const index = queue.shift()!;
        ...
    }
});
```

This is safe in Node.js because `queue.length` check and `queue.shift()` execute synchronously within a single microtask, and the `await` on line 158 yields at well-defined points. But it relies on the single-threaded guarantee and would break if this code were ever ported to a worker-thread model.

---

### 16. `local.ts` cleanup race with detached process group

`src/providers/local.ts:126-131`, `src/providers/local.ts:143`

Because agent commands are spawned with `detached: true`, the process group may still be running when `cleanup()` attempts to `fs.remove` the workspace directory. If the agent process is writing to a file at that moment, `fs.remove` could fail with EBUSY on some systems.

The `finish()` handler in `runCommand` only resolves after the `close` event, and `evalRunner.ts:324` cleanup runs in the `finally` block after the trial completes. But if the abort signal fires and `finish()` resolves early (while the SIGKILL escalation timer is still pending), the cleanup could race with the dying process.

**Recommendation**: Wait a brief interval after killing the process group before attempting directory removal, or retry removal on EBUSY.

---

### 17. Browser preview server never closes

`src/reporters/browser.ts:41-48`

The HTTP server is created and listens but is never closed. There is no `server.close()` call and no signal handler. When used via `pathgrade preview browser`, the process hangs forever (which is the intent -- the user Ctrl+C to stop). But there is no cleanup of the server socket on shutdown.

This is acceptable for the intended use case but worth noting if the preview server is ever integrated into other flows.

---

## Summary

| Severity | Count | Key themes |
|----------|-------|------------|
| Critical | 2     | No SIGINT handler (zombie processes, temp dir leaks); shared prompt file path under parallel execution |
| Major    | 6     | Grader timeout doesn't kill work; CLI child process leaks; non-atomic report writes; unbounded memory from stdout; late command callback data corruption |
| Minor    | 6     | Disk growth; transcript growth; path traversal; timeout semantics; cleanup error masking; base64 ARG_MAX |
| Nit      | 3     | Queue synchronization assumption; cleanup race with detached processes; unclosed server |
