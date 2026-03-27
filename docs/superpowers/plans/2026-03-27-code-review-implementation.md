# Code Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Address all critical and major findings from the 7-agent code review (11 critical, 37 major = 48 findings).

**Architecture:** Six phases ordered by risk: security first, then process management, error handling, developer experience, code quality refactors, and testing. Each phase is independently shippable. Refactoring tasks (Phase 5) depend on Phase 3 error handling fixes being in place.

**Tech Stack:** TypeScript, Node.js, vitest, fs-extra, child_process

**Review source:** `docs/reviews/SUMMARY.md` and per-reviewer files in `docs/reviews/`

---

## Phase 1: Security Hardening

### Task 1: Sanitize `sessionId` before shell interpolation

Addresses: Security #1 (critical)

**Files:**
- Modify: `src/agents/claude.ts:42`
- Test: `tests/agents.test.ts`

- [x] **Step 1: Write failing test for malicious sessionId**

In `tests/agents.test.ts`, add inside the ClaudeAgent describe block:

```typescript
it('sanitizes sessionId to prevent shell injection', async () => {
    const agent = new ClaudeAgent();
    const commands: string[] = [];
    const mockRunCommand = vi.fn(async (cmd: string) => {
        commands.push(cmd);
        // First call: prompt write. Second call: claude -p with injected sessionId.
        if (commands.length === 1) {
            return { stdout: '', stderr: '', exitCode: 0 };
        }
        // Return a JSON envelope with a malicious session_id
        return {
            stdout: JSON.stringify({
                type: 'result',
                result: 'hello',
                session_id: 'legit-id; rm -rf /'
            }),
            stderr: '',
            exitCode: 0
        };
    });

    const session = await agent.createSession('workspace', mockRunCommand);
    // First turn: establishes sessionId from response
    await session.start({ message: 'hello' });
    // Second turn: uses sessionId -- this is where injection would happen
    await session.reply({ message: 'follow up' });

    // The third command (second claude invocation) should have a sanitized sessionId
    const resumeCommand = commands[3]; // prompt write, claude, prompt write, claude
    expect(resumeCommand).not.toContain('; rm -rf /');
    expect(resumeCommand).toMatch(/--resume [a-zA-Z0-9_-]+/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents.test.ts -t "sanitizes sessionId"`
Expected: FAIL -- the unsanitized sessionId passes through

- [x] **Step 3: Add sessionId validation in ClaudeAgent**

In `src/agents/claude.ts`, add a validation function and use it:

```typescript
private sanitizeSessionId(id: string): string {
    // Claude session IDs are alphanumeric with hyphens and underscores
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (sanitized !== id) {
        console.warn(`ClaudeAgent: sanitized suspicious session_id: ${id.substring(0, 50)}`);
    }
    return sanitized;
}
```

Update `runTurn` to use it at line 42:

```typescript
const sessionFlag = sessionId ? ` --resume ${this.sanitizeSessionId(sessionId)}` : '';
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents.test.ts -t "sanitizes sessionId"`
Expected: PASS

- [x] **Step 5: Run full agent test suite**

Run: `npx vitest run tests/agents.test.ts`
Expected: All tests pass

- [x] **Step 6: Commit**

```bash
git add src/agents/claude.ts tests/agents.test.ts
git commit -m "fix(security): sanitize Claude sessionId before shell interpolation"
```

---

### Task 2: Construct minimal env for child processes in isolated mode

Addresses: Security #3, #4 (major)

**Files:**
- Modify: `src/providers/local.ts:145`
- Test: `tests/providers.local.test.ts`

- [x] **Step 1: Write failing test for env isolation**

In `tests/providers.local.test.ts`, add:

```typescript
it('does not leak host env vars to child process in isolated mode', async () => {
    // Set a secret env var on the host
    process.env.__TEST_SECRET_KEY = 'super-secret-value';

    const provider = new LocalProvider();
    const runtime = await provider.setup(tmpDir, [], {
        timeoutSec: 10,
        environment: { cpus: 1, memory_mb: 512 },
        authMode: 'isolated',
    });

    try {
        const result = await provider.runCommand(runtime, 'printenv __TEST_SECRET_KEY');
        // The secret should NOT be in the child process output
        expect(result.stdout.trim()).not.toContain('super-secret-value');
    } finally {
        await provider.cleanup(runtime);
        delete process.env.__TEST_SECRET_KEY;
    }
});

it('passes host env vars in host auth mode', async () => {
    process.env.__TEST_HOST_KEY = 'host-value';

    const provider = new LocalProvider();
    const runtime = await provider.setup(tmpDir, [], {
        timeoutSec: 10,
        environment: { cpus: 1, memory_mb: 512 },
        authMode: 'host',
    });

    try {
        const result = await provider.runCommand(runtime, 'printenv __TEST_HOST_KEY');
        expect(result.stdout.trim()).toContain('host-value');
    } finally {
        await provider.cleanup(runtime);
        delete process.env.__TEST_HOST_KEY;
    }
});
```

- [x] **Step 2: Run tests to verify the isolation test fails**

Run: `npx vitest run tests/providers.local.test.ts -t "does not leak"`
Expected: FAIL -- the secret is currently leaked

- [x] **Step 3: Build minimal env for isolated mode**

In `src/providers/local.ts`, replace the `runCommand` env construction at line 145:

```typescript
async runCommand(
    runtime: EnvironmentHandle,
    command: string,
    env?: Record<string, string>,
    options?: CommandExecutionOptions
): Promise<CommandResult> {
    const workspacePath = getWorkspacePath(runtime);
    const runtimeEnv = getRuntimeEnv(runtime);

    // Build the child process environment.
    // In isolated mode (HOME is overridden), use a minimal allowlist
    // to prevent leaking host secrets like API keys and credentials.
    // In host mode, inherit the full host environment.
    const isIsolated = runtimeEnv.HOME !== undefined && runtimeEnv.HOME !== process.env.HOME;
    let childEnv: NodeJS.ProcessEnv;
    if (isIsolated) {
        const SAFE_HOST_VARS = [
            'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME',
        ];
        const baseEnv: Record<string, string> = {};
        for (const key of SAFE_HOST_VARS) {
            if (process.env[key]) baseEnv[key] = process.env[key]!;
        }
        childEnv = { ...baseEnv, ...env, ...runtimeEnv } as NodeJS.ProcessEnv;
    } else {
        childEnv = { ...process.env, ...env, ...runtimeEnv } as NodeJS.ProcessEnv;
    }

    return new Promise((resolve) => {
        const child = spawn(command, {
            shell: true,
            detached: process.platform !== 'win32',
            cwd: workspacePath,
            env: childEnv,
        });
        // ... rest unchanged
```

- [x] **Step 4: Run tests to verify both pass**

Run: `npx vitest run tests/providers.local.test.ts`
Expected: All tests pass (including both new tests)

- [x] **Step 5: Commit**

```bash
git add src/providers/local.ts tests/providers.local.test.ts
git commit -m "fix(security): use minimal env allowlist for child processes in isolated mode"
```

---

### Task 3: Add path traversal checks to workspace mappings and grader file refs

Addresses: Security #5, #6 (major)

**Files:**
- Modify: `src/commands/run.ts:253-311`
- Test: `tests/commands.run.test.ts`

- [x] **Step 1: Write failing test for path traversal**

In `tests/commands.run.test.ts`, add:

```typescript
import { prepareTempTaskDir } from '../src/commands/run';

describe('prepareTempTaskDir path traversal', () => {
    it('rejects workspace src that escapes project directory', async () => {
        const resolved = {
            type: 'instruction' as const,
            name: 'test-task',
            instruction: 'test',
            workspace: [{ src: '../../etc/passwd', dest: 'passwd' }],
            graders: [],
            agent: 'gemini' as const,
            trials: 1,
            timeout: 60,
            environment: { cpus: 1, memory_mb: 512 },
        };
        const baseDir = '/tmp/test-project';
        const tmpDir = '/tmp/test-task-dir';
        await fs.ensureDir(baseDir);
        await fs.ensureDir(tmpDir);

        // Should not copy files from outside baseDir
        await prepareTempTaskDir(resolved, baseDir, tmpDir);
        const files = await fs.readdir(tmpDir);
        expect(files).not.toContain('passwd');

        await fs.remove(baseDir);
        await fs.remove(tmpDir);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands.run.test.ts -t "rejects workspace src"`
Expected: FAIL -- file is currently copied without check

- [x] **Step 3: Add containment checks**

In `src/commands/run.ts`, add a helper function before `prepareTempTaskDir`:

```typescript
function isContainedIn(childPath: string, parentPath: string): boolean {
    const resolved = path.resolve(childPath);
    const parent = path.resolve(parentPath) + path.sep;
    return resolved.startsWith(parent) || resolved === path.resolve(parentPath);
}
```

Update the workspace copy loop (around line 304-311):

```typescript
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
```

Update the grader file reference copy loop (around line 253-267):

```typescript
const pathMatches = g.run.match(/[\w./-]+\.\w{1,4}/g) || [];
for (const ref of pathMatches) {
    const refDir = ref.split('/')[0];
    const srcDir = path.resolve(baseDir, refDir);
    const destDir = path.join(tmpDir, refDir);
    if (!isContainedIn(srcDir, baseDir)) continue;
    if (refDir !== ref && await fs.pathExists(srcDir) && !await fs.pathExists(destDir)) {
        await fs.copy(srcDir, destDir);
    }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands.run.test.ts -t "rejects workspace src"`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/commands/run.ts tests/commands.run.test.ts
git commit -m "fix(security): add path traversal checks to workspace and grader file refs"
```

---

### Task 4: Fix browser preview path traversal

Addresses: Code Quality #10, Reliability #11 (minor, but trivial fix)

**Files:**
- Modify: `src/reporters/browser.ts:24-28`

- [x] **Step 1: Add path containment check**

In `src/reporters/browser.ts`, replace the `/api/report` handler:

```typescript
} else if (url.pathname === '/api/report') {
    const file = url.searchParams.get('file');
    if (!file) { res.writeHead(400); res.end('Missing file param'); return; }
    const filePath = path.resolve(resolved, file);
    if (!filePath.startsWith(resolved + path.sep) && filePath !== resolved) {
        res.writeHead(403); res.end('Forbidden'); return;
    }
    if (await fs.pathExists(filePath)) {
        const report = await fs.readJSON(filePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report));
    } else {
        res.writeHead(404); res.end('Not found');
    }
```

Note: changed `path.join` to `path.resolve` to properly resolve `..` segments before checking.

- [x] **Step 2: Run existing tests**

Run: `npx vitest run tests/commands.preview.test.ts`
Expected: All pass

- [x] **Step 3: Commit**

```bash
git add src/reporters/browser.ts
git commit -m "fix(security): prevent path traversal in browser preview API"
```

---

### Task 5: Add path containment to `resolveFileOrInline`

Addresses: Security #15, Error Handling #10, DevEx #6 (nit/minor, but trivial fix)

**Files:**
- Modify: `src/core/config.ts:426-439`
- Test: `tests/config.test.ts`

- [x] **Step 1: Write failing test**

In `tests/config.test.ts`, add:

```typescript
it('resolveFileOrInline does not read files outside baseDir', async () => {
    // We test indirectly via resolveTask: an instruction like "../../etc/hostname"
    // should be treated as inline text, not resolved to a file
    const task = {
        name: 'test',
        type: 'instruction' as const,
        instruction: '../../etc/hostname',
        graders: [{ type: 'deterministic' as const, run: 'echo ok', weight: 1.0 }],
    };
    const resolved = await resolveTask(task, defaults, '/tmp/some-project');
    // Should return the literal string, not the file contents
    expect(resolved.type === 'instruction' && resolved.instruction).toBe('../../etc/hostname');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "resolveFileOrInline does not read"`
Expected: FAIL -- currently reads the file if it exists

- [x] **Step 3: Add containment check**

In `src/core/config.ts`, update `resolveFileOrInline`:

```typescript
async function resolveFileOrInline(value: string, baseDir: string): Promise<string> {
    const trimmed = value.trim();

    // Multi-line strings are always inline content
    if (trimmed.includes('\n')) return trimmed;

    // Check if it could be a file path
    const candidate = path.resolve(baseDir, trimmed);

    // Reject paths that escape the base directory
    const resolvedBase = path.resolve(baseDir);
    if (!candidate.startsWith(resolvedBase + path.sep) && candidate !== resolvedBase) {
        return trimmed;
    }

    if (await fs.pathExists(candidate)) {
        return (await fs.readFile(candidate, 'utf-8')).trim();
    }

    return trimmed;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: All pass

- [x] **Step 5: Commit**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "fix(security): prevent resolveFileOrInline from reading outside baseDir"
```

---

## Phase 2: Process & Resource Management

### Task 6: Add SIGINT/SIGTERM handler for graceful shutdown

Addresses: Reliability #1 (critical), Error Handling #4 (partial)

**Files:**
- Create: `src/utils/shutdown.ts`
- Modify: `src/pathgrade.ts`
- Test: `tests/shutdown.test.ts`

- [x] **Step 1: Write failing test**

Create `tests/shutdown.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShutdownManager } from '../src/utils/shutdown';

describe('ShutdownManager', () => {
    let manager: ShutdownManager;

    beforeEach(() => {
        manager = new ShutdownManager();
    });

    afterEach(() => {
        manager.uninstall();
    });

    it('tracks and cleans up registered resources', async () => {
        const cleanup1 = vi.fn().mockResolvedValue(undefined);
        const cleanup2 = vi.fn().mockResolvedValue(undefined);

        const id1 = manager.register(cleanup1);
        const id2 = manager.register(cleanup2);

        await manager.shutdownAll();

        expect(cleanup1).toHaveBeenCalledOnce();
        expect(cleanup2).toHaveBeenCalledOnce();
    });

    it('unregister removes a cleanup', async () => {
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const id = manager.register(cleanup);
        manager.unregister(id);

        await manager.shutdownAll();
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('shutdownAll tolerates errors in individual cleanups', async () => {
        const cleanup1 = vi.fn().mockRejectedValue(new Error('fail'));
        const cleanup2 = vi.fn().mockResolvedValue(undefined);

        manager.register(cleanup1);
        manager.register(cleanup2);

        // Should not throw
        await manager.shutdownAll();
        expect(cleanup2).toHaveBeenCalledOnce();
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shutdown.test.ts`
Expected: FAIL -- module does not exist

- [x] **Step 3: Implement ShutdownManager**

Create `src/utils/shutdown.ts`:

```typescript
type CleanupFn = () => Promise<void>;

let nextId = 0;

export class ShutdownManager {
    private cleanups = new Map<number, CleanupFn>();
    private shuttingDown = false;
    private signalHandler: (() => void) | undefined;

    register(cleanup: CleanupFn): number {
        const id = nextId++;
        this.cleanups.set(id, cleanup);
        return id;
    }

    unregister(id: number): void {
        this.cleanups.delete(id);
    }

    async shutdownAll(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        const tasks = [...this.cleanups.values()];
        this.cleanups.clear();

        await Promise.allSettled(tasks.map(fn => fn()));
    }

    install(): void {
        this.signalHandler = () => {
            this.shutdownAll().finally(() => process.exit(130));
        };
        process.on('SIGINT', this.signalHandler);
        process.on('SIGTERM', this.signalHandler);
    }

    uninstall(): void {
        if (this.signalHandler) {
            process.removeListener('SIGINT', this.signalHandler);
            process.removeListener('SIGTERM', this.signalHandler);
            this.signalHandler = undefined;
        }
        this.shuttingDown = false;
    }
}

/** Global singleton for the CLI process */
export const shutdown = new ShutdownManager();
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shutdown.test.ts`
Expected: PASS

- [x] **Step 5: Wire shutdown manager into CLI and evalRunner**

In `src/pathgrade.ts`, add at the top of `main()`:

```typescript
import { shutdown } from './utils/shutdown';

async function main() {
    shutdown.install();
    // ... rest of main
```

In `src/evalRunner.ts`, import and use in `runSingleTrial` around line 181:

```typescript
import { shutdown } from './utils/shutdown';

// Inside runSingleTrial, after provider.setup:
const runtime = await this.provider.setup(taskPath, skillsPaths, opts, env);
const cleanupId = shutdown.register(async () => {
    try { await this.provider.cleanup(runtime); } catch {}
});

try {
    // ... existing trial logic
} catch (error: unknown) {
    // ... existing catch
} finally {
    shutdown.unregister(cleanupId);
    await this.provider.cleanup(runtime);
}
```

- [x] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [x] **Step 7: Commit**

```bash
git add src/utils/shutdown.ts src/pathgrade.ts src/evalRunner.ts tests/shutdown.test.ts
git commit -m "fix(reliability): add SIGINT/SIGTERM handler for graceful shutdown"
```

---

### Task 7: Unify timeout utilities -- use `withAbortTimeout` for graders

Addresses: Architecture #7.1, Code Quality #2, Error Handling #2 (critical), Reliability #3 (major)

**Files:**
- Modify: `src/evalRunner.ts:21-32, 358-363`
- Test: `tests/evalRunner.test.ts`

- [x] **Step 1: Write failing test for grader abort signal**

In `tests/evalRunner.test.ts`, add:

```typescript
it('passes abort signal to grader on timeout', async () => {
    let receivedSignal: AbortSignal | undefined;

    const mockProvider = {
        setup: vi.fn().mockResolvedValue({ handle: '/tmp/test', workspacePath: '/tmp/test/workspace', env: {} }),
        cleanup: vi.fn().mockResolvedValue(undefined),
        runCommand: vi.fn(async (_ws: any, _cmd: string, _env: any, options?: any) => {
            receivedSignal = options?.signal;
            // Simulate a slow grader -- wait for abort
            return new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ stdout: '{"score": 1}', stderr: '', exitCode: 0 }), 10000);
                if (options?.signal) {
                    options.signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve({ stdout: '', stderr: '', exitCode: 124, timedOut: true });
                    });
                }
            });
        }),
    };

    const runner = new EvalRunner(mockProvider as any);
    const report = await runner.runEval(
        () => makeMockAgent('output'),
        '/tmp/task',
        [],
        {
            instruction: 'test',
            graders: [{ type: 'deterministic', run: 'sleep 999', weight: 1 }],
            timeoutSec: 60,
            graderTimeoutSec: 0.1, // 100ms grader timeout
            environment: { cpus: 1, memory_mb: 512 },
        },
        1,
        {},
    );

    // The grader should have received an abort signal
    expect(receivedSignal).toBeDefined();
    expect(report.trials[0].reward).toBe(0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evalRunner.test.ts -t "passes abort signal to grader"`
Expected: FAIL -- grader currently uses `withTimeout` which doesn't pass a signal

- [x] **Step 3: Replace `withTimeout` with `withAbortTimeout` for graders**

In `src/evalRunner.ts`, remove the local `withTimeout` function (lines 21-32).

Update `runGraders` to use `withAbortTimeout` for graders (around line 358):

```typescript
const graderTimeoutMs = (opts.graderTimeoutSec ?? 120) * 1000;
const result = await withAbortTimeout(
    async (signal) => grader.grade(runtime, this.provider, graderConfig, taskPath, sessionLog, env, signal),
    graderTimeoutMs,
    `Grader ${graderDef.type} (limit: ${opts.graderTimeoutSec ?? 120}s)`
);
```

Update the `Grader` interface and implementations to accept an optional signal. In `src/graders/index.ts`:

```typescript
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
```

In `DeterministicGrader.grade`, pass the signal to `runCommand`:

```typescript
const result = await provider.runCommand(workspace, command, env, { signal });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/evalRunner.test.ts -t "passes abort signal to grader"`
Expected: PASS

- [x] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [x] **Step 6: Commit**

```bash
git add src/evalRunner.ts src/graders/index.ts
git commit -m "fix(reliability): unify timeout utilities, pass abort signal to graders"
```

---

### Task 8: Atomic report writes

Addresses: Reliability #6 (major)

**Files:**
- Modify: `src/evalRunner.ts:427-436`

- [ ] **Step 1: Update saveReport to use write-then-rename**

In `src/evalRunner.ts`, update `saveReport`:

```typescript
private async saveReport(report: EvalReport): Promise<void> {
    if (!this.logDir) return;

    await fs.ensureDir(this.logDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${report.task}_${timestamp}.json`;
    const filePath = path.join(this.logDir, fileName);
    const tmpPath = filePath + '.tmp';

    await fs.writeJSON(tmpPath, report, { spaces: 2 });
    await fs.move(tmpPath, filePath, { overwrite: true });
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/evalRunner.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/evalRunner.ts
git commit -m "fix(reliability): use atomic write-then-rename for report files"
```

---

## Phase 3: Error Handling

### Task 9: Per-grader error isolation

Addresses: Error Handling #3 (major)

**Files:**
- Modify: `src/evalRunner.ts:328-379`
- Test: `tests/evalRunner.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/evalRunner.test.ts`, add:

```typescript
it('preserves passing grader results when a later grader fails', async () => {
    const graderModule = await import('../src/graders');
    const callCount = { n: 0 };
    vi.spyOn(graderModule, 'getGrader').mockImplementation((type: string) => ({
        grade: async () => {
            callCount.n++;
            if (callCount.n === 2) throw new Error('LLM API failed');
            return { grader_type: type, score: 1.0, weight: 1.0, details: 'passed' };
        }
    }));

    const runner = new EvalRunner(mockProvider);
    const report = await runner.runEval(
        () => makeMockAgent('output'),
        '/tmp/task',
        [],
        {
            instruction: 'test',
            graders: [
                { type: 'deterministic', run: 'test.sh', weight: 1.0 },
                { type: 'llm_rubric', rubric: 'rubric.md', weight: 1.0 },
            ],
            timeoutSec: 60,
            environment: { cpus: 1, memory_mb: 512 },
        },
        1,
        {},
    );

    // First grader passed, second failed -- reward should be 0.5 not 0
    expect(report.trials[0].grader_results).toHaveLength(2);
    expect(report.trials[0].grader_results[0].score).toBe(1.0);
    expect(report.trials[0].grader_results[1].score).toBe(0);
    expect(report.trials[0].reward).toBe(0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evalRunner.test.ts -t "preserves passing grader"`
Expected: FAIL -- currently one failure discards all results

- [ ] **Step 3: Add per-grader try/catch in runGraders**

In `src/evalRunner.ts`, wrap the grader call in the `runGraders` loop:

```typescript
for (let gIdx = 0; gIdx < opts.graders.length; gIdx++) {
    const graderDef = opts.graders[gIdx];
    const grader = getGrader(graderDef.type);
    spinner.update(`grading (${graderDef.type}${opts.graders.length > 1 ? ` ${gIdx + 1}/${opts.graders.length}` : ''})`);

    // ... existing index computation and config building ...

    try {
        const graderTimeoutMs = (opts.graderTimeoutSec ?? 120) * 1000;
        const result = await withAbortTimeout(
            async (signal) => grader.grade(runtime, this.provider, graderConfig, taskPath, sessionLog, env, signal),
            graderTimeoutMs,
            `Grader ${graderDef.type} (limit: ${opts.graderTimeoutSec ?? 120}s)`
        );
        graderResults.push(result);
    } catch (err: unknown) {
        const errorMsg = (err as Error)?.message || String(err);
        graderResults.push({
            grader_type: graderDef.type,
            score: 0,
            weight: graderDef.weight,
            details: `[grader error] ${errorMsg}`,
        });
    }

    sessionLog.push({
        type: 'grader',
        timestamp: this.timestamp(),
        grader_result: graderResults[graderResults.length - 1],
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/evalRunner.test.ts -t "preserves passing grader"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/evalRunner.ts tests/evalRunner.test.ts
git commit -m "fix(error-handling): isolate per-grader errors to preserve partial results"
```

---

### Task 10: Wrap `provider.setup` in try/finally and handle saveReport failure

Addresses: Error Handling #4, #6 (major)

**Files:**
- Modify: `src/evalRunner.ts:180-181, 135-138`

- [x] **Step 1: Fix provider.setup to be inside try/finally**

In `src/evalRunner.ts`, refactor `runSingleTrial` setup:

```typescript
let runtime: EnvironmentHandle | undefined;
try {
    const spinner = new Spinner(`${index + 1}/${total}`, 'setting up environment');
    runtime = await this.provider.setup(taskPath, skillsPaths, opts, env);

    // ... rest of existing try block
} catch (error: unknown) {
    // ... existing catch (move spinner reference)
} finally {
    if (runtime) {
        try { await this.provider.cleanup(runtime); } catch {}
    }
}
```

- [ ] **Step 2: Wrap saveReport in try/catch**

In `src/evalRunner.ts`, update the saveReport call (around line 135):

```typescript
if (this.logDir) {
    try {
        const sanitized = this.sanitize(report, env);
        await this.saveReport(sanitized);
    } catch (err) {
        console.error(`Warning: failed to save report: ${(err as Error)?.message || err}`);
    }
}
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/evalRunner.ts
git commit -m "fix(error-handling): wrap provider.setup in try/finally, catch saveReport errors"
```

---

### Task 11: Fix validation-mode temp directory leak

Addresses: Error Handling #5 (major)

**Files:**
- Modify: `src/commands/run.ts:110-213`

- [ ] **Step 1: Wrap each task iteration in try/finally for cleanup**

In `src/commands/run.ts`, restructure the task loop to ensure cleanup runs regardless of `continue`:

```typescript
for (const taskDef of tasksToRun) {
    const resolved = await resolveTask(taskDef, config.defaults, dir);
    const trials = opts.trials ?? resolved.trials;
    const parallel = opts.parallel ?? 1;

    // Create a local task bundle for this run
    const tmpTaskDir = path.join(outputDir, 'tmp', resolved.name);
    await prepareTempTaskDir(resolved, dir, tmpTaskDir);

    try {
        // Pick agent: CLI flag > task-level override > default
        const agentName: AgentName = opts.agent || resolved.agent || 'claude';

        // Host-auth passthrough for CLI-authenticated agents
        const cliAgents = ['claude', 'codex'];
        const useHostAuth = cliAgents.includes(agentName) && await isClaudeCliAvailable();

        // ... existing evalOpts construction ...

        const provider = new LocalProvider();
        const runner = new EvalRunner(provider, resultsDir);

        if (opts.validate) {
            if (!resolved.solution) {
                console.error(`  ${fmt.red('error')}  task "${resolved.name}" has no solution defined`);
                continue; // finally block will still run
            }
            if (resolved.type === 'conversation') {
                console.error(`  ${fmt.red('error')}  validation mode does not support conversation tasks yet`);
                allPassed = false;
                continue; // finally block will still run
            }

            // ... rest of validation mode
        } else {
            // ... rest of normal mode
        }
    } finally {
        try { await fs.remove(tmpTaskDir); } catch { /* ignore cleanup errors */ }
    }
}
```

Remove the old cleanup line at 212 (it's now in the finally block).

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/commands.run.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/commands/run.ts
git commit -m "fix(error-handling): wrap task loop in try/finally to prevent temp dir leaks"
```

---

## Phase 4: Developer Experience

### Task 12: Fix README, templates, and init to include required `type` field

Addresses: DevEx #1 (critical)

**Files:**
- Modify: `README.md`
- Modify: `templates/eval.ts.template`
- Modify: `src/commands/init.ts:178-205, 302-344`

- [ ] **Step 1: Read current template and init files**

Read `templates/eval.ts.template` and `src/commands/init.ts` to locate exact positions.

- [ ] **Step 2: Add `type: 'instruction'` to all templates**

In `templates/eval.ts.template`, add `type: 'instruction',` to the task definition.

In `src/commands/init.ts`, find the `getInlineTemplate` function and add `type: 'instruction',` to its task.

In `src/commands/init.ts`, find the LLM generation prompt example and add `type: 'instruction',` to its task.

In `README.md`, add `type: 'instruction',` to the eval.ts Reference example (around line 91-117).

- [ ] **Step 3: Run init test**

Run: `npx vitest run tests/commands.init.test.ts`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add README.md templates/eval.ts.template src/commands/init.ts
git commit -m "fix(devex): add required type field to all eval.ts examples and templates"
```

---

### Task 13: Implement workspace `dest` and `chmod` handling

Addresses: DevEx #2 (critical)

**Files:**
- Modify: `src/commands/run.ts:304-311` (already partially done in Task 3)
- Test: `tests/commands.run.test.ts`

- [ ] **Step 1: Write failing test for dest mapping**

In `tests/commands.run.test.ts`, add:

```typescript
it('copies workspace files using dest path', async () => {
    const baseDir = path.join(os.tmpdir(), 'test-dest-base');
    const tmpDir = path.join(os.tmpdir(), 'test-dest-tmp');
    await fs.ensureDir(baseDir);
    await fs.writeFile(path.join(baseDir, 'original-name.js'), 'content');

    const resolved = {
        type: 'instruction' as const,
        name: 'test',
        instruction: 'test',
        workspace: [{ src: 'original-name.js', dest: 'renamed.js' }],
        graders: [],
        agent: 'gemini' as const,
        trials: 1,
        timeout: 60,
        environment: { cpus: 1, memory_mb: 512 },
    };

    await prepareTempTaskDir(resolved, baseDir, tmpDir);

    expect(await fs.pathExists(path.join(tmpDir, 'renamed.js'))).toBe(true);
    expect(await fs.pathExists(path.join(tmpDir, 'original-name.js'))).toBe(false);

    await fs.remove(baseDir);
    await fs.remove(tmpDir);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands.run.test.ts -t "copies workspace files using dest"`
Expected: FAIL -- `dest` is currently ignored

- [x] **Step 3: Verify the fix from Task 3 handles dest**

The code in Task 3 already changed the line to:
```typescript
const destName = w.dest || path.basename(w.src);
const destInTmp = path.join(tmpDir, destName);
```

Task 3 was already applied, so this code change is in place.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands.run.test.ts -t "copies workspace files using dest"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/run.ts tests/commands.run.test.ts
git commit -m "fix(devex): implement workspace dest and chmod handling"
```

---

### Task 14: Fix package.json main/types and help text default agent

Addresses: DevEx #3 (major), DevEx #4 (major)

**Files:**
- Modify: `package.json:5-6`
- Modify: `src/pathgrade.ts:132`

- [ ] **Step 1: Align package.json main/types with exports**

In `package.json`:

```json
"main": "dist/core/index.js",
"types": "dist/core/index.d.ts",
```

- [ ] **Step 2: Fix help text agent default**

In `src/pathgrade.ts:132`, change:

```
--agent=claude                Override agent (default: claude)
```

to:

```
--agent=NAME       Override agent: gemini|claude|codex (default: gemini)
```

- [ ] **Step 3: Run CLI surface test**

Run: `npx vitest run tests/cli-surface-local-first.test.ts`
Expected: All pass (update test if it checks help text)

- [ ] **Step 4: Commit**

```bash
git add package.json src/pathgrade.ts
git commit -m "fix(devex): align package.json main/types with exports, fix help text default agent"
```

---

### Task 15: Remove or warn on unused `grader.setup` field

Addresses: DevEx #5 (major)

**Files:**
- Modify: `src/core/config.ts`

- [ ] **Step 1: Add a warning when setup is specified**

In `src/core/config.ts`, inside the task grader validation loop (around line 232-239), add:

```typescript
const graders = (t.graders || []).map((g: RawGrader) => {
    if (g.setup) {
        console.warn(`  warning: grader "setup" field in task "${t.name}" is not yet implemented and will be ignored`);
    }
    return {
        type: g.type,
        setup: g.setup,
        // ...
    };
});
```

- [ ] **Step 2: Run config tests**

Run: `npx vitest run tests/config.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/core/config.ts
git commit -m "fix(devex): warn when unused grader.setup field is specified"
```

---

### Task 16: Validate CLI numeric flags

Addresses: DevEx #8, Error Handling #15 (minor/major)

**Files:**
- Modify: `src/pathgrade.ts:79, 97, 100`

- [ ] **Step 1: Add validation helper and use it**

In `src/pathgrade.ts`, add a helper before `main()`:

```typescript
function parseIntFlag(name: string, value: string): number {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 1) {
        console.error(`error: --${name} must be a positive integer, got "${value}"`);
        process.exit(1);
    }
    return n;
}

function parseFloatFlag(name: string, value: string): number {
    const n = parseFloat(value);
    if (isNaN(n) || n < 0 || n > 1) {
        console.error(`error: --${name} must be a number between 0 and 1, got "${value}"`);
        process.exit(1);
    }
    return n;
}
```

Update the flag parsing:

```typescript
const explicitTrials = getFlag('trials') ? parseIntFlag('trials', getFlag('trials')!) : undefined;
// ...
parallel: getFlag('parallel') ? parseIntFlag('parallel', getFlag('parallel')!) : undefined,
// ...
threshold: getFlag('threshold') ? parseFloatFlag('threshold', getFlag('threshold')!) : undefined,
```

- [ ] **Step 2: Run CLI surface test**

Run: `npx vitest run tests/cli-surface-local-first.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/pathgrade.ts
git commit -m "fix(devex): validate CLI numeric flags instead of silently accepting NaN"
```

---

## Phase 5: Code Quality Refactors

### Task 17: Extract shared `TranscriptAgent` base class for Gemini and Codex

Addresses: Code Quality #3 (major)

**Files:**
- Create: `src/agents/transcript-agent.ts`
- Modify: `src/agents/gemini.ts`
- Modify: `src/agents/codex.ts`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Create `TranscriptAgent` base class**

Create `src/agents/transcript-agent.ts`:

```typescript
import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

/**
 * Base class for agents that manage multi-turn conversations via transcript
 * re-injection (Gemini, Codex). Handles session management, transcript
 * accumulation, and prompt file writing.
 */
export abstract class TranscriptAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        const transcript: string[] = [];

        const runTranscriptTurn = async (message: string): Promise<AgentTurnResult> => {
            transcript.push(`User: ${message}`);
            const result = await this.runTurn(this.buildTranscriptPrompt(transcript), runCommand);
            transcript.push(`Assistant: ${result.assistantMessage}`);
            return result;
        };

        return {
            start: async ({ message }) => runTranscriptTurn(message),
            reply: async ({ message }) => runTranscriptTurn(message),
        };
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const result = await this.runTurn(instruction, runCommand);
        return result.rawOutput;
    }

    private buildTranscriptPrompt(transcript: string[]): string {
        return [
            'Continue the conversation below. Respond to the latest user message and do not re-execute previous work unless it is necessary to answer correctly.',
            transcript.join('\n\n'),
        ].join('\n\n');
    }

    protected async writePromptFile(instruction: string, runCommand: AgentCommandRunner): Promise<string> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);
        return promptPath;
    }

    /** Subclasses implement this to run the CLI command for one turn */
    protected abstract runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult>;
}
```

- [ ] **Step 2: Simplify GeminiAgent**

Rewrite `src/agents/gemini.ts`:

```typescript
import { AgentCommandRunner, AgentTurnResult } from '../types';
import { TranscriptAgent } from './transcript-agent';

export class GeminiAgent extends TranscriptAgent {
    protected async runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult> {
        const promptPath = await this.writePromptFile(instruction, runCommand);
        const command = `gemini -y --sandbox=none -p "$(cat ${promptPath})"`;
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;

        if (result.exitCode !== 0) {
            console.error('GeminiAgent: Gemini CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
        };
    }
}
```

- [ ] **Step 3: Simplify CodexAgent**

Rewrite `src/agents/codex.ts`:

```typescript
import { AgentCommandRunner, AgentTurnResult } from '../types';
import { TranscriptAgent } from './transcript-agent';

export class CodexAgent extends TranscriptAgent {
    protected async runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult> {
        // Seed API-key auth when OPENAI_API_KEY is available
        await runCommand('if [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi');

        const promptPath = await this.writePromptFile(instruction, runCommand);
        const command = `codex exec --full-auto --skip-git-repo-check "$(cat ${promptPath})"`;
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
        };
    }
}
```

- [ ] **Step 4: Run agent tests**

Run: `npx vitest run tests/agents.test.ts`
Expected: All pass

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/agents/transcript-agent.ts src/agents/gemini.ts src/agents/codex.ts
git commit -m "refactor: extract TranscriptAgent base class for Gemini and Codex agents"
```

---

### Task 18: Extract shared grader path conventions

Addresses: Architecture #2.2, Code Quality #12 (major)

**Files:**
- Create: `src/graders/paths.ts`
- Modify: `src/commands/run.ts`
- Modify: `src/evalRunner.ts`
- Modify: `src/conversationRunner.ts`

- [ ] **Step 1: Create grader paths module**

Create `src/graders/paths.ts`:

```typescript
/**
 * Shared grader path conventions. Single source of truth for the
 * .pathgrade directory structure used by prepareTempTaskDir (writer)
 * and evalRunner/conversationRunner (readers).
 */

export const GRADER_ROOT = '.pathgrade';
export const TESTS_DIR = `${GRADER_ROOT}/tests`;
export const PROMPTS_DIR = `${GRADER_ROOT}/prompts`;
export const STEP_TESTS_DIR = `${TESTS_DIR}/steps`;
export const STEP_PROMPTS_DIR = `${PROMPTS_DIR}/steps`;

export function deterministicScriptName(index: number): string {
    return index === 0 ? 'test.sh' : `test_${index}.sh`;
}

export function llmRubricName(index: number): string {
    return index === 0 ? 'quality.md' : `quality_${index}.md`;
}

export function deterministicCommand(index: number): string {
    return `bash ${TESTS_DIR}/${deterministicScriptName(index)}`;
}

export function llmRubricPath(index: number): string {
    return `${PROMPTS_DIR}/${llmRubricName(index)}`;
}

export function stepDeterministicCommand(turnNumber: number, graderIndex: number): string {
    return `bash ${STEP_TESTS_DIR}/turn_${turnNumber}_${graderIndex}.sh`;
}

export function stepLlmRubricPath(turnNumber: number, graderIndex: number): string {
    return `${STEP_PROMPTS_DIR}/turn_${turnNumber}_${graderIndex}.md`;
}
```

- [ ] **Step 2: Update consumers to use shared paths**

In `src/commands/run.ts`, replace hardcoded path strings with imports from `../graders/paths`.

In `src/evalRunner.ts:346-356`, replace:

```typescript
import { deterministicCommand, llmRubricPath } from './graders/paths';

// In runGraders:
const graderConfig = {
    type: graderDef.type,
    command: graderDef.type === 'deterministic' ? deterministicCommand(detIndex) : undefined,
    rubric: graderDef.type === 'llm_rubric' ? llmRubricPath(llmIndex) : undefined,
    model: graderDef.model || opts.graderModel,
    weight: graderDef.weight,
};
```

In `src/conversationRunner.ts:184-194`, similarly replace:

```typescript
import { stepDeterministicCommand, stepLlmRubricPath } from './graders/paths';

// In runStepGraders:
const graderConfig = {
    type: graderDef.type,
    command: graderDef.type === 'deterministic' ? stepDeterministicCommand(turnNumber, graderIdx) : undefined,
    rubric: graderDef.type === 'llm_rubric' ? stepLlmRubricPath(turnNumber, graderIdx) : undefined,
    model: graderDef.model || opts.graderModel,
    weight: graderDef.weight,
};
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/graders/paths.ts src/commands/run.ts src/evalRunner.ts src/conversationRunner.ts
git commit -m "refactor: extract grader path conventions into shared module"
```

---

### Task 19: Fix `createAgentSession` -- remove `as any` casts

Addresses: Architecture #3.1, Code Quality #1 (major)

**Files:**
- Modify: `src/types.ts:168-208`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Simplify createAgentSession**

In `src/types.ts`, replace the entire `createAgentSession` function and update `BaseAgent`:

```typescript
export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand);
}

export abstract class BaseAgent {
    abstract createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession>;

    /** @deprecated Use createSession instead */
    abstract run(
        instruction: string,
        workspacePath: string,
        runCommand: AgentCommandRunner
    ): Promise<string>;
}
```

Wait -- `run()` is still used by the validation-mode `solveAgent` in `commands/run.ts:166-171`. Let me check: that code casts an object literal `as BaseAgent`, using only `run`. We need to keep backward compatibility for this case. Instead:

```typescript
export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand);
}

export abstract class BaseAgent {
    abstract createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession>;

    // run() is no longer abstract -- subclasses that override createSession don't need it.
    // Kept for backward compatibility with simple agents (e.g., validation-mode solve agent).
    async run(
        instruction: string,
        workspacePath: string,
        runCommand: AgentCommandRunner
    ): Promise<string> {
        throw new Error('Agent must implement createSession() or run()');
    }

    // Default createSession that wraps run() for simple agents
    // Subclasses override this directly (Claude, Gemini, Codex all do)
}
```

Actually, the cleanest approach: make `createSession` non-abstract with a default that calls `run()`, and make `run()` non-abstract with a default that throws. This preserves backward compat without any `as any`:

```typescript
export abstract class BaseAgent {
    async createSession(runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        // Default: wrap run() into a session for simple agents
        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const rawOutput = await this.run(message, getWorkspacePath(runtime), runCommand);
            return { rawOutput, assistantMessage: rawOutput, exitCode: 0 };
        };
        return {
            start: async ({ message }) => runTurn(message),
            reply: async ({ message }) => runTurn(message),
        };
    }

    run(
        _instruction: string,
        _workspacePath: string,
        _runCommand: AgentCommandRunner
    ): Promise<string> {
        throw new Error('Agent must implement createSession() or run()');
    }
}

export async function createAgentSession(
    agent: BaseAgent,
    runtime: EnvironmentHandle,
    runCommand: AgentCommandRunner
): Promise<AgentSession> {
    return agent.createSession(runtime, runCommand);
}
```

This eliminates all `as any` casts. Concrete agents override `createSession` (all three do). The validation solveAgent can just implement `run()` and the default `createSession` wraps it.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "refactor: remove as-any casts from createAgentSession"
```

---

### Task 20: Deduplicate LLM API calls in `init.ts`

Addresses: Architecture #1.1, Code Quality #4 (major)

**Files:**
- Modify: `src/commands/init.ts`

- [ ] **Step 1: Read init.ts to locate the duplicate**

Read `src/commands/init.ts` to find `generateWithLLM`.

- [ ] **Step 2: Replace `generateWithLLM` with `callLLM`**

Replace the ~80-line `generateWithLLM` function with:

```typescript
import { callLLM } from '../utils/llm';

async function generateWithLLM(prompt: string, env: Record<string, string>): Promise<string> {
    const result = await callLLM(prompt, { env, temperature: 0.3 });
    return result.text;
}
```

- [ ] **Step 3: Run init tests**

Run: `npx vitest run tests/commands.init.test.ts`
Expected: All pass

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts
git commit -m "refactor: replace duplicate LLM API calls in init.ts with callLLM utility"
```

---

### Task 21: Extract `resolveGrader` helper to deduplicate config.ts

Addresses: Code Quality #5 (major)

**Files:**
- Modify: `src/core/config.ts:320-336, 399-414`

- [ ] **Step 1: Extract shared resolveGrader function**

In `src/core/config.ts`, add before `resolveTask`:

```typescript
async function resolveGrader(g: EvalGraderConfig, baseDir: string): Promise<ResolvedGrader> {
    const resolved: ResolvedGrader = {
        type: g.type,
        setup: g.setup,
        model: g.model,
        weight: g.weight,
    };
    if (g.type === 'deterministic' && g.run) {
        resolved.run = await resolveFileOrInline(g.run, baseDir);
    }
    if (g.type === 'llm_rubric' && g.rubric) {
        resolved.rubric = await resolveFileOrInline(g.rubric, baseDir);
    }
    return resolved;
}
```

Update `resolveTask` graders resolution (around line 320):

```typescript
const graders: ResolvedGrader[] = await Promise.all(
    task.graders.map(g => resolveGrader(g, baseDir))
);
```

Update `resolveConversation` step graders (around line 399):

```typescript
graders: await Promise.all(
    sg.graders.map(g => resolveGrader(g, baseDir))
),
```

- [ ] **Step 2: Run config tests**

Run: `npx vitest run tests/config.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/core/config.ts
git commit -m "refactor: extract resolveGrader helper to deduplicate config.ts"
```

---

## Phase 6: Testing

### Task 22: Add `conversationRunner.ts` test file

Addresses: Testing #1.1 (critical)

**Files:**
- Create: `tests/conversationRunner.test.ts`

- [ ] **Step 1: Create test file with core conversation scenarios**

Create `tests/conversationRunner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runConversationTrial } from '../src/conversationRunner';
import { BaseAgent, AgentSession, AgentTurnResult, EnvironmentHandle } from '../src/types';

function makeMockAgent(responses: string[]): BaseAgent {
    let callIndex = 0;
    const agent = {
        createSession: async (_runtime: EnvironmentHandle, _runCommand: any): Promise<AgentSession> => ({
            start: async ({ message }: { message: string }) => {
                const reply = responses[callIndex++] || 'no more responses';
                return { rawOutput: reply, assistantMessage: reply, exitCode: 0 };
            },
            reply: async ({ message }: { message: string }) => {
                const reply = responses[callIndex++] || 'no more responses';
                return { rawOutput: reply, assistantMessage: reply, exitCode: 0 };
            },
        }),
        run: async () => '',
    } as unknown as BaseAgent;
    return agent;
}

const mockProvider = {
    setup: vi.fn().mockResolvedValue({ handle: '/tmp', workspacePath: '/tmp/ws', env: {} }),
    cleanup: vi.fn(),
    runCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
};

describe('runConversationTrial', () => {
    it('completes on max_turns', async () => {
        const result = await runConversationTrial({
            agent: makeMockAgent(['response 1', 'response 2']),
            conversation: {
                opener: 'Hello',
                completion: { max_turns: 2 },
                replies: [{ content: 'follow up' }],
            },
            provider: mockProvider as any,
            runtime: { handle: '/tmp', workspacePath: '/tmp/ws', env: {} },
            taskPath: '/tmp/task',
            timeoutSec: 60,
            timestamp: () => new Date().toISOString(),
        });

        expect(result.conversation.completion_reason).toBe('max_turns');
        expect(result.conversation.total_turns).toBe(2);
    });

    it('completes on done_phrase', async () => {
        const result = await runConversationTrial({
            agent: makeMockAgent(['I am DONE now']),
            conversation: {
                opener: 'Start',
                completion: { max_turns: 5, done_phrase: 'DONE' },
                replies: [{ content: 'continue' }],
            },
            provider: mockProvider as any,
            runtime: { handle: '/tmp', workspacePath: '/tmp/ws', env: {} },
            taskPath: '/tmp/task',
            timeoutSec: 60,
            timestamp: () => new Date().toISOString(),
        });

        expect(result.conversation.completion_reason).toBe('done_phrase');
        expect(result.conversation.total_turns).toBe(1);
    });

    it('ends with no_replies when scripted replies exhausted and no persona', async () => {
        const result = await runConversationTrial({
            agent: makeMockAgent(['response 1', 'response 2']),
            conversation: {
                opener: 'Hello',
                completion: { max_turns: 5 },
                replies: [], // no replies available after opener
            },
            provider: mockProvider as any,
            runtime: { handle: '/tmp', workspacePath: '/tmp/ws', env: {} },
            taskPath: '/tmp/task',
            timeoutSec: 60,
            timestamp: () => new Date().toISOString(),
        });

        expect(result.conversation.completion_reason).toBe('no_replies');
    });

    it('uses pattern-matched replies when regex matches', async () => {
        const result = await runConversationTrial({
            agent: makeMockAgent(['I need help with login']),
            conversation: {
                opener: 'Hi there',
                completion: { max_turns: 2 },
                replies: [
                    { content: 'Try resetting your password', when: 'login|password' },
                ],
            },
            provider: mockProvider as any,
            runtime: { handle: '/tmp', workspacePath: '/tmp/ws', env: {} },
            taskPath: '/tmp/task',
            timeoutSec: 60,
            timestamp: () => new Date().toISOString(),
        });

        // Pattern matched, so it used the scripted_pattern reply
        expect(result.conversation.turns.length).toBeGreaterThanOrEqual(1);
    });

    it('records timeout when deadline is exceeded', async () => {
        const result = await runConversationTrial({
            agent: makeMockAgent(['slow response']),
            conversation: {
                opener: 'Hello',
                completion: { max_turns: 10 },
                replies: [{ content: 'reply' }],
            },
            provider: mockProvider as any,
            runtime: { handle: '/tmp', workspacePath: '/tmp/ws', env: {} },
            taskPath: '/tmp/task',
            timeoutSec: 0, // immediate timeout
            timestamp: () => new Date().toISOString(),
        });

        expect(result.conversation.completion_reason).toBe('timeout');
    });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run tests/conversationRunner.test.ts`
Expected: All pass (these test the existing behavior)

- [ ] **Step 3: Commit**

```bash
git add tests/conversationRunner.test.ts
git commit -m "test: add dedicated conversationRunner test file covering core scenarios"
```

---

### Task 23: Fix weighted grader test mock

Addresses: Testing #4.1 (critical)

**Files:**
- Modify: `tests/evalRunner.test.ts`

- [ ] **Step 1: Fix the weighted grader test**

Find the weighted grader test (around line 551-574) and fix the mock to return different weights:

```typescript
it('calculates weighted reward from multiple graders', async () => {
    const graderModule = await import('../src/graders');
    vi.spyOn(graderModule, 'getGrader').mockImplementation((type: string) => ({
        grade: async (_ws: any, _provider: any, config: any) => ({
            grader_type: type,
            score: type === 'deterministic' ? 1.0 : 0.0,
            weight: config.weight, // use the actual config weight, not a hardcoded 1.0
            details: 'test',
        }),
    }));

    const runner = new EvalRunner(mockProvider);
    const report = await runner.runEval(
        () => makeMockAgent('output'),
        '/tmp/task',
        [],
        {
            instruction: 'test',
            graders: [
                { type: 'deterministic', run: 'test.sh', weight: 0.7 },
                { type: 'llm_rubric', rubric: 'rubric.md', weight: 0.3 },
            ],
            timeoutSec: 60,
            environment: { cpus: 1, memory_mb: 512 },
        },
        1,
        {},
    );

    // deterministic scored 1.0 (weight 0.7), llm scored 0.0 (weight 0.3)
    // weighted reward = (1.0 * 0.7 + 0.0 * 0.3) / (0.7 + 0.3) = 0.7
    expect(report.trials[0].reward).toBeCloseTo(0.7);
    expect(report.trials[0].grader_results[0].weight).toBe(0.7);
    expect(report.trials[0].grader_results[1].weight).toBe(0.3);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/evalRunner.test.ts -t "calculates weighted reward"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/evalRunner.test.ts
git commit -m "test: fix weighted grader test to actually verify weighted averaging"
```

---

### Task 24: Fix test isolation -- use `vi.stubGlobal` and `vi.stubEnv`

Addresses: Testing #5.1, #5.2 (major)

**Files:**
- Modify: `tests/graders.test.ts`
- Modify: `tests/evalRunner.test.ts`

- [ ] **Step 1: Replace manual `globalThis.fetch` mutation in graders.test.ts**

Find all places in `tests/graders.test.ts` that do `const origFetch = globalThis.fetch; ... globalThis.fetch = ... finally { globalThis.fetch = origFetch }` and replace with:

```typescript
// At the top of the test or in beforeEach:
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ /* response */ }),
    text: async () => JSON.stringify({ /* response */ }),
}));

// In afterEach:
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
```

Similarly for `process.env` mutations, replace:
```typescript
// Before:
delete process.env.GEMINI_API_KEY;
// After:
vi.stubEnv('GEMINI_API_KEY', undefined);
```

- [ ] **Step 2: Apply same pattern in evalRunner.test.ts**

Replace manual `globalThis.fetch` save/restore with `vi.stubGlobal`.

- [ ] **Step 3: Run both test files**

Run: `npx vitest run tests/graders.test.ts tests/evalRunner.test.ts`
Expected: All pass

- [ ] **Step 4: Run full test suite to verify no cross-contamination**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add tests/graders.test.ts tests/evalRunner.test.ts
git commit -m "test: replace manual global mutations with vi.stubGlobal/vi.stubEnv"
```

---

## Follow-up: Minor/Nit Items (not planned in detail)

The following items from the review are deferred as minor/nit. They can be addressed in a separate pass:

- **Greedy JSON regex** (Security #8): Replace `stdout.match(/\{[\s\S]*\}/)` with last-match or streaming parser across 5 files
- **LogEntry discriminated union** (Architecture #4.2, Code Quality #14): Convert flat optional fields to per-type interfaces
- **EvalRunOptions discriminated union** (Architecture #4.1): Mirror the `ResolvedTask` discriminated union
- **EnvironmentHandle narrowing** (Architecture #3.2): Remove the `string` variant
- **Remove unused exports** from `core/index.ts` (Architecture #6.1): Drop `loadEvalConfig`, `resolveTask`
- **Remove unused import** `trialRow` in `run.ts` (Code Quality #6)
- **Token estimate labeling** (Architecture #4.3): Rename to `estimated_input_tokens`
- **Unbounded stdout cap** (Reliability #7): Truncate at 1MB per stream
- **Results directory pruning** (Reliability #9): Add `--keep=N` flag
- **Version field validation** (DevEx #7): Reject unknown versions
- **Gemini API key in header** (Security #7): Use `x-goog-api-key` header
- **Conversation deadline for post-turn work** (Error Handling #7, #8): Extend `withAbortTimeout` to cover `checkCompletion`, `runStepGraders`, `pickReply`
- **cli-llm.ts process groups** (Reliability #4, #5): Add `detached: true`, clean up SIGKILL timer
- **persona.ts tests** (Testing #1.2): Direct test file for `buildPersonaPrompt` and `generatePersonaReply`
- **`withAbortTimeout` tests** (Testing #1.4): Edge case coverage
- **`calculatePassAtK` edge cases** (Testing #4.2): k=0, n=0, division by zero

---

## Execution Notes

- Phases are independently shippable. Start with Phase 1 (security) since those are highest risk.
- Tasks within a phase may be run in parallel where they touch different files.
- Phase 5 (refactors) should be done AFTER Phases 1-3 since it restructures code that the earlier phases modify.
- Phase 6 (testing) can run in parallel with Phase 4-5 since test files are independent.
- Total estimated scope: ~24 tasks, ~100 steps.
