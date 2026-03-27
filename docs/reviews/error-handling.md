# Error Handling & Edge Cases Review

**Reviewer focus**: Silent failures, unhandled rejections, partial failure handling, resource cleanup, invalid input, timeout edge cases, and race conditions.

---

## Critical

### 1. Parallel trials share a mutable queue without synchronization

`src/evalRunner.ts:152-163`

```ts
const queue = Array.from({ length: numTrials }, (_, index) => index);
const workers = Array.from({ length: Math.min(parallel, numTrials) }, async () => {
    while (queue.length > 0) {
        const index = queue.shift()!;
        results[index] = await this.runSingleTrial(...);
    }
});
```

The `queue` array is mutated by multiple concurrent async workers via `.shift()`. While JavaScript is single-threaded (so two `.shift()` calls will not literally interleave), the check `queue.length > 0` and the `.shift()` are separated by an `await`. This is safe in practice because the `await` yields and the next iteration re-checks `queue.length`. However, the pattern is fragile -- if any synchronous code were added between the check and the shift (or if the check were cached), it would break. More importantly, there is a real correctness gap: if `runSingleTrial` throws synchronously (before its first `await`), the exception propagates to the worker, killing that worker silently. The remaining items in the queue assigned to that worker are never processed, and `Promise.all(workers)` resolves with a partially-filled `results` array containing `undefined` entries that will cause NaN in the pass-rate calculation.

**Impact**: A synchronous throw in trial setup (e.g., `agentFactory()` throws) silently drops trials and corrupts the report with NaN scores.

### 2. Grader timeout kills the grader but does not propagate the abort to child processes

`src/evalRunner.ts:21-32` (the `withTimeout` helper used for graders)

```ts
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}
```

Unlike `withAbortTimeout` (used for agent execution), this `withTimeout` merely races a timer against the promise. When the timer fires, it rejects the outer promise, but the inner grader promise keeps running -- the spawned grader process (deterministic shell script) is never killed. For a long-running or hung grader, this means:
- The shell process leaks and continues consuming resources.
- Its stdout/stderr buffers keep growing.
- If multiple trials use parallel grading, leaked processes accumulate.

Compare with the agent path (`withAbortTimeout` in `src/utils/timeout.ts`) which passes an `AbortSignal` that the `LocalProvider.runCommand` uses to kill the child process group.

**Impact**: A hung deterministic grader script will leak a zombie process per trial. On a 30-trial regression run with `--parallel`, this can exhaust system resources.

---

## Major

### 3. `runGraders` does not catch per-grader errors -- one grader crash fails the entire trial

`src/evalRunner.ts:328-379`

If any single grader throws (e.g., the LLM API returns a network error that `callLLM` does not catch, or `withTimeout` rejects), the error propagates up through `runGraders` into `runSingleTrial`'s catch block, which records `reward: 0` and an empty `grader_results: []`. This means:

- Results from graders that already ran successfully are discarded.
- The session log loses partial grader data.
- For a task with both a `deterministic` and an `llm_rubric` grader, a transient LLM API failure zeroes out even a passing deterministic score.

A per-grader try/catch that records `score: 0` for the failed grader while preserving others would be more appropriate.

### 4. `provider.setup` failure in `runSingleTrial` skips cleanup

`src/evalRunner.ts:180-181`

```ts
const runtime = await this.provider.setup(taskPath, skillsPaths, opts, env);
try {
    // ... trial logic
} catch { ... } finally {
    await this.provider.cleanup(runtime);
}
```

The `setup` call is outside the try/finally. If `setup` partially succeeds (e.g., creates the temp directory tree but fails during `fs.copy`), the partially-created temp directory is never cleaned up. The `LocalProvider.setup` (`src/providers/local.ts:18-124`) creates multiple directories before the copy step, so a failure at line 25 (`fs.copy(taskPath, workspacePath)`) leaves orphaned directories in `/tmp`.

### 5. Validation-mode `continue` statements bypass temp directory cleanup

`src/commands/run.ts:111, 152-162, 211-212`

In validation mode, `prepareTempTaskDir` creates a temp bundle at line 111-112 before the validation checks. Two early exits then skip cleanup:

```ts
if (!resolved.solution) {
    console.error(`  task "${resolved.name}" has no solution defined`);
    continue;  // line 156 -- skips cleanup at line 212
}
if (resolved.type === 'conversation') {
    console.error(`  validation mode does not support conversation tasks yet`);
    allPassed = false;
    continue;  // line 160 -- skips cleanup at line 212
}
```

Both `continue` statements jump back to the for-loop head, bypassing the `try { await fs.remove(tmpTaskDir); } catch {}` at line 212. The temp directory at `outputDir/tmp/<taskName>` (containing copied workspace files and grader scripts) is leaked on disk.

Additionally, if the validation run itself (`runner.runEval` at line 173) throws, the error propagates out of the for-loop entirely -- there is no try/finally wrapping the validation path, unlike the normal eval path (lines 189-208).

### 6. Agent non-zero exit code is logged but not treated as a failure

`src/agents/claude.ts:50-52`, `src/agents/gemini.ts:50-52`, `src/agents/codex.ts:54-56`

All three agents handle non-zero exit codes identically:
```ts
if (result.exitCode !== 0) {
    console.error('ClaudeAgent: Claude failed to execute correctly.');
}
```

The agent still returns `rawOutput` and the trial proceeds to grading. This is reasonable for partial output, but the `console.error` is easy to miss in CI output. More importantly, if the CLI crashes with no stdout at all, the grader receives an empty workspace and scores `0` with no indication in the report that the agent itself crashed (vs. simply producing wrong output). The `exitCode` is available on the `AgentTurnResult` but is never used downstream by `evalRunner` or `conversationRunner` to flag the trial.

### 6. `saveReport` failure is unhandled and will crash the process

`src/evalRunner.ts:135-138`

```ts
if (this.logDir) {
    const sanitized = this.sanitize(report, env);
    await this.saveReport(sanitized);
}
```

If `saveReport` throws (disk full, permissions error), the exception propagates out of `runEval` and the entire eval run aborts. All trial data computed so far is lost because the report was never returned to the caller. This should be wrapped in a try/catch so that a report-writing failure does not discard results.

### 7. `conversationRunner` step graders run without timeout

`src/conversationRunner.ts:169-211`

```ts
const result = await grader.grade(
    opts.runtime, opts.provider, graderConfig,
    opts.taskPath, sessionLog, opts.env
);
```

Step graders are invoked with no timeout wrapper at all. A hung step grader (deterministic script or LLM call) blocks the conversation loop indefinitely. The top-level conversation timeout (`deadlineMs`) only applies to the agent turn via `withAbortTimeout`, not to step graders or `checkCompletion`.

### 8. `checkCompletion` with `done_when` can block indefinitely on LLM call

`src/conversationRunner.ts:131-163`

The `callLLM` invocation inside `checkCompletion` has no timeout. If the LLM API hangs, the conversation loop blocks forever. The catch block on line 161 handles errors but not hangs. The overall conversation deadline (`deadlineMs`) only governs the `withAbortTimeout` around the agent turn, not the completion check or reply generation.

---

## Minor

### 9. Workspace file copy silently skips missing files

`src/commands/run.ts:305-311`

```ts
for (const w of resolved.workspace) {
    const srcPath = path.resolve(baseDir, w.src);
    const destInTmp = path.join(tmpDir, path.basename(w.src));
    if (await fs.pathExists(srcPath)) {
        await fs.copy(srcPath, destInTmp);
    }
}
```

If a workspace file does not exist, it is silently skipped. This can lead to confusing grader failures when the expected file is missing from the workspace. A warning would help users debug eval configs.

### 10. `resolveFileOrInline` heuristic can misidentify inline content as a file path

`src/core/config.ts:426-439`

```ts
async function resolveFileOrInline(value: string, baseDir: string): Promise<string> {
    const trimmed = value.trim();
    if (trimmed.includes('\n')) return trimmed;
    const candidate = path.resolve(baseDir, trimmed);
    if (await fs.pathExists(candidate)) {
        return (await fs.readFile(candidate, 'utf-8')).trim();
    }
    return trimmed;
}
```

A single-line instruction like `"README.md"` or `"test"` that happens to match a filename in the project directory will be silently resolved to the file contents instead of being used as a literal instruction. There is no way for the user to force literal interpretation.

### 11. `prepareTempTaskDir` regex for grader file references is fragile

`src/commands/run.ts:257-267`

```ts
const pathMatches = g.run.match(/[\w./-]+\.\w{1,4}/g) || [];
for (const ref of pathMatches) {
    const refDir = ref.split('/')[0];
    // ...
    await fs.copy(srcDir, destDir);
}
```

The regex `[\w./-]+\.\w{1,4}` matches any word-like string with a dot and 1-4 char extension. This can match environment variables (`$HOME/foo.txt`), URLs (`api.test`), or other non-path strings, causing spurious copy attempts. The `fs.pathExists` check on line 262 prevents errors, but the pattern is unreliable for discovering actual file dependencies.

### 12. `cli-llm.ts` timeout does not clean up the timer on successful completion

`src/utils/cli-llm.ts:147-152`

```ts
const timer = setTimeout(() => {
    if (!settled) {
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 500);
    }
}, timeoutSec * 1000);
```

The inner `setTimeout` (500ms SIGKILL fallback) is never cleared. If the process exits normally after SIGTERM but before the 500ms, the callback fires and calls `child.kill('SIGKILL')` on an already-dead process. This is harmless (it throws ESRCH which is ignored), but it leaves a dangling timer reference that prevents Node from exiting promptly if this is the last pending operation.

### 13. `AnalyticsEngine.loadReports` does not validate JSON shape

`src/analytics/engine.ts:26-38`

```ts
for (const file of files) {
    if (file.endsWith('.json')) {
        const report = await fs.readJSON(path.join(logDir, file));
        reports.push(report);
    }
}
```

Any `.json` file in the results directory is loaded and cast as `EvalReport` without validation. A malformed or unrelated JSON file will cause runtime errors downstream when accessing `.trials`, `.pass_rate`, etc. The `cli.ts` reporter (`src/reporters/cli.ts:22-23`) has a try/catch for this, but the analytics engine does not.

### 14. `BaseAgent.createSession` can recurse infinitely

`src/types.ts:199-202`

```ts
export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        return createAgentSession(this, runtime, runCommand);
    }
```

And in `createAgentSession` (`src/types.ts:173-178`):
```ts
if (
    typeof (agent as any).createSession === 'function' &&
    (agent as any).createSession !== BaseAgent.prototype.createSession
) {
    return await (agent as any).createSession(runtime, runCommand);
}
```

The guard `!== BaseAgent.prototype.createSession` prevents recursion for the base class, but if a subclass overrides `createSession` and calls `super.createSession()`, which calls `createAgentSession`, which sees the override and calls it again, you get infinite recursion. This does not happen with the current agents (they all override `createSession` without calling `super`), but is a latent footgun for future agent implementations.

### 15. `parseInt` / `parseFloat` for CLI flags do not validate results

`src/pathgrade.ts:79,97,100`

```ts
const explicitTrials = getFlag('trials') ? parseInt(getFlag('trials')!) : undefined;
// ...
parallel: getFlag('parallel') ? parseInt(getFlag('parallel')!) : undefined,
// ...
threshold: getFlag('threshold') ? parseFloat(getFlag('threshold')!) : undefined,
```

`parseInt('abc')` returns `NaN`, which propagates silently. `--trials=abc` results in `NaN` trials, which causes the `for` loop in `runEval` to execute zero iterations (since `i < NaN` is false), producing an empty report with `NaN` pass rates. No error is shown to the user.

### 16. Conversation persona retry silently swallows the first error

`src/conversationRunner.ts:245-268`

```ts
for (let attempt = 0; attempt < 2; attempt++) {
    try {
        const personaReply = await generatePersonaReply(...);
        // ...
    } catch (err) {
        if (attempt === 0) continue;
        // Second failure -- fall through to return null
    }
}
return null;
```

On the first persona failure, the error is completely swallowed (no logging). On the second failure, `null` is returned which ends the conversation with `completion_reason: 'no_replies'`. The user has no visibility into why the conversation ended early. At minimum, the error message should be logged on both attempts.

---

## Nit

### 17. `withAbortTimeout` rejects with timeout error even if the inner promise resolved/rejected first

`src/utils/timeout.ts:23-39`

If the inner promise resolves right as the timer fires (i.e., `timedOut` becomes true between the `clearTimeout` and the `resolve` check), the resolved value is discarded and replaced with a timeout error. This is a narrow race window but could cause a passing trial to be recorded as timed out.

### 18. Grader weight defaults to `config.weight` which may be `undefined`

`src/graders/index.ts:42-47`, `src/graders/index.ts:98-101`

Both `DeterministicGrader` and `LLMGrader` use `config.weight` directly in the returned `GraderResult`. The `GraderConfig.weight` field is typed as `number` but comes from the config pipeline which defaults to `1.0` at parse time (`src/core/config.ts:238`). If someone constructs a `GraderConfig` manually (e.g., in tests) without setting `weight`, the weighted average in `runGraders` divides by `undefined`, producing `NaN`.

### 19. `Spinner` is instantiated even when stdout is not a TTY

`src/evalRunner.ts:180,96`

The `Spinner` class is created for every trial and for the build step. If stdout is piped (CI, logging), spinner ANSI escape sequences pollute the output. This is a UX issue rather than an error handling issue, but it can make CI logs harder to parse for error diagnosis.
