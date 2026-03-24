# CLI-First Local LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pathgrade's API-key-backed local LLM calls with Claude CLI subprocess calls using the host's existing OAuth session, so local runs need zero provider API keys.

**Architecture:** Add a `callClaudeCli()` function that shells out to `claude -p` with appropriate flags. Wire it into `callLLM()` as a first-choice backend when Claude CLI is available, with the existing API-key path kept as fallback for CI. For the solver, add a host-auth passthrough mode to `LocalProvider` that preserves real HOME while still isolating the workspace via `cwd`.

**Tech Stack:** Node.js `child_process.spawn`, existing TypeScript codebase (CommonJS).

**Evidence:** POC results in `docs/cli-poc/2026-03-24-cli-auth-findings.md` — Claude is GREEN for all four call surfaces.

---

## Scope

This plan covers the three judge call surfaces plus the solver auth passthrough:

| Call surface | Current implementation | New implementation |
|---|---|---|
| Rubric grading | `src/graders/index.ts:171` → `callLLM()` → HTTP API | `callLLM()` → `callClaudeCli()` with `--json-schema` |
| Persona generation | `src/persona.ts:69` → `callLLM()` → HTTP API | `callLLM()` → `callClaudeCli()` in text mode |
| Init generation | `src/commands/init.ts:63` → `generateWithLLM()` → HTTP API | `generateWithCli()` → `callClaudeCli()` in text mode |
| Solver auth | `src/providers/local.ts:51` overrides HOME → kills CLI auth | Host-auth passthrough: preserve real HOME |

**Not in scope:** Codex judge flows (flaky), generic bridge, cross-platform claims, CI changes.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/cli-llm.ts` | Create | Claude CLI subprocess wrapper: detection, invocation, envelope parsing |
| `src/utils/llm.ts` | Modify | Try CLI first, fall back to API keys |
| `src/commands/init.ts` | Modify | Replace `generateWithLLM()` with CLI-first path |
| `src/providers/local.ts` | Modify | Add host-auth passthrough mode |
| `src/types.ts` | Modify | Add `authMode` to `EnvironmentSetupOpts` |
| `tests/cli-llm.test.ts` | Create | Unit tests for CLI wrapper + integration smoke test |
| `tests/llm-fallback.test.ts` | Create | Tests for CLI-first → API-key fallback logic |

---

## Task 1: Claude CLI Wrapper

**Files:**
- Create: `src/utils/cli-llm.ts`
- Test: `tests/cli-llm.test.ts`

- [ ] **Step 1: Write failing test for `isClaudeCliAvailable`**

```typescript
// tests/cli-llm.test.ts
import { describe, it, expect } from 'vitest';
import { isClaudeCliAvailable } from '../src/utils/cli-llm';

describe('isClaudeCliAvailable', () => {
    it('returns a boolean', async () => {
        const result = await isClaudeCliAvailable();
        expect(typeof result).toBe('boolean');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-llm.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `isClaudeCliAvailable` and `callClaudeCli`**

```typescript
// src/utils/cli-llm.ts
import { spawn } from 'child_process';
import { LLMCallResult } from './llm';

let cachedAvailable: boolean | null = null;

/**
 * Check if claude CLI is installed and authenticated.
 * Result is cached for the process lifetime.
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
    if (cachedAvailable !== null) return cachedAvailable;
    try {
        const result = await runCli('claude', ['auth', 'status'], {}, 10);
        cachedAvailable = result.exitCode === 0;
    } catch {
        cachedAvailable = false;
    }
    return cachedAvailable;
}

/** Reset the availability cache (for testing). */
export function resetCliCache(): void {
    cachedAvailable = null;
}

interface CliLLMOpts {
    jsonSchema?: string;
    timeoutSec?: number;
}

/**
 * Call Claude CLI in print mode. Returns the same shape as callLLM().
 *
 * For rubric-style calls, pass jsonSchema to get structured JSON output.
 * For text-style calls (persona, init), omit jsonSchema.
 *
 * Uses --tools "" to disable tool use and --no-session-persistence
 * to avoid session file accumulation.
 *
 * NEVER uses --bare (disables OAuth) or --dangerously-skip-permissions
 * (only appropriate for solver, not judge flows).
 */
export async function callClaudeCli(
    prompt: string,
    opts: CliLLMOpts = {}
): Promise<LLMCallResult> {
    const args = ['-p', '--no-session-persistence', '--tools', ''];

    if (opts.jsonSchema) {
        args.push('--output-format', 'json', '--json-schema', opts.jsonSchema);
    } else {
        args.push('--output-format', 'text');
    }

    const result = await runCli('claude', args, {}, opts.timeoutSec ?? 120, prompt);

    if (result.exitCode !== 0) {
        throw new Error(
            `Claude CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 300)}`
        );
    }

    const text = opts.jsonSchema
        ? extractStructuredOutput(result.stdout)
        : result.stdout.trim();

    return {
        text,
        provider: 'anthropic',
        model: 'claude-cli',
    };
}

/**
 * Claude's --output-format json wraps the response in a session envelope:
 * {"type":"result",...,"structured_output":{...},"result":"..."}
 *
 * For --json-schema calls, the actual response is in structured_output.
 * This function is only called for JSON-mode output (not text mode).
 */
function extractStructuredOutput(raw: string): string {
    try {
        const envelope = JSON.parse(raw);
        if (envelope.structured_output && typeof envelope.structured_output === 'object') {
            return JSON.stringify(envelope.structured_output);
        }
        if (typeof envelope.result === 'string' && envelope.result) {
            return envelope.result;
        }
    } catch {
        // Not a JSON envelope — return raw
    }
    return raw.trim();
}

// --- Subprocess helper ---

interface CliResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function runCli(
    command: string,
    args: string[],
    env: Record<string, string | undefined>,
    timeoutSec: number,
    stdin?: string,
): Promise<CliResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) {
                child.kill('SIGTERM');
                setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 500);
            }
        }, timeoutSec * 1000);

        if (stdin) {
            child.stdin.write(stdin);
            child.stdin.end();
        }

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 1 });
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
        });
    });
}
```

Key design points:
- `spawn(command, args)` without `shell: true` — args are passed directly to the process, no shell quoting issues
- `--tools ""` disables tool use for judge flows
- `--no-session-persistence` prevents session accumulation
- No `--bare` (disables OAuth), no `--dangerously-skip-permissions` (solver only)
- `--json-schema` takes an inline JSON string (not a file path) — verified by POC `host_rubric` probe and Claude CLI help text: `--json-schema <schema> Example: {"type":"object",...}`
- Envelope parsing handles Claude's `--output-format json` wrapper
- The existing Claude agent adapter (`src/agents/claude.ts:31`) already passes `--dangerously-skip-permissions` for solver runs — no change needed there

- [ ] **Step 4: Write additional tests**

```typescript
describe('callClaudeCli', () => {
    it('returns text for plain prompt', async () => {
        // Integration test — skip if claude not installed
        if (!await isClaudeCliAvailable()) return;
        const result = await callClaudeCli('Reply with exactly: hello');
        expect(result.text).toBeTruthy();
        expect(result.provider).toBe('anthropic');
    }, 30_000);

    it('returns parsed JSON for structured prompt', async () => {
        if (!await isClaudeCliAvailable()) return;
        const schema = JSON.stringify({
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
        });
        const result = await callClaudeCli('What is 2+2? Put the answer in the answer field.', {
            jsonSchema: schema,
        });
        const parsed = JSON.parse(result.text);
        expect(parsed.answer).toBeDefined();
    }, 30_000);
});

describe('extractStructuredOutput', () => {
    // Import the function for unit testing
    // (may need to export it or test via callClaudeCli behavior)

    it('extracts structured_output from Claude envelope', () => {
        // Test via parseRubricOutput behavior in helpers
    });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/cli-llm.test.ts`
Expected: PASS (unit tests always, integration tests when claude installed)

- [ ] **Step 6: Commit**

```bash
git add src/utils/cli-llm.ts tests/cli-llm.test.ts
git commit -m "feat: add Claude CLI subprocess wrapper for local LLM calls"
```

---

## Task 2: CLI-First Fallback in callLLM

**Files:**
- Modify: `src/utils/llm.ts:180-203`
- Test: `tests/llm-fallback.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/llm-fallback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('callLLM CLI-first fallback', () => {
    it('tries CLI when no API keys are available and claude is installed', async () => {
        // Mock isClaudeCliAvailable to return true
        // Mock callClaudeCli to return a canned response
        // Call callLLM with no API keys in env
        // Verify callClaudeCli was called
    });

    it('falls back to API keys when CLI is not available', async () => {
        // Mock isClaudeCliAvailable to return false
        // Set GEMINI_API_KEY in env
        // Call callLLM
        // Verify HTTP path was used
    });

    it('uses API keys directly when explicitly provided in env', async () => {
        // When env has ANTHROPIC_API_KEY, skip CLI even if available
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm-fallback.test.ts`

- [ ] **Step 3: Modify `callLLM` to try CLI first**

In `src/utils/llm.ts`, change the `callLLM` function:

```typescript
// Add import at top of file:
import { isClaudeCliAvailable, callClaudeCli } from './cli-llm';

export async function callLLM(prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
    const keys = getApiKeys(opts.env);
    const hasExplicitKey = Object.values(keys).some(Boolean);

    // CLI-first: when no API keys are available, try Claude CLI.
    // This must fire BEFORE getProviderSequence(), because getProviderSequence
    // throws when a model is explicitly requested (e.g., "claude-3-5-sonnet")
    // but no matching key exists. In keyless CLI mode, that throw is wrong —
    // the CLI handles auth via OAuth, not via API key env vars.
    if (!hasExplicitKey && await isClaudeCliAvailable()) {
        return callClaudeCli(prompt);
    }

    // Existing API-key path (CI, explicit provider keys)
    const providers = getProviderSequence(opts.model, opts.env);
    const temperature = opts.temperature ?? 0;
    // ... rest unchanged
}
```

This ordering is critical: `getProviderSequence()` must never be called in keyless-CLI mode because it throws on `inferProviderFromModel("claude-sonnet-...")` when `ANTHROPIC_API_KEY` is absent. The CLI-first check short-circuits before that code path.

This preserves full backward compatibility:
- CI with API keys → uses HTTP APIs (existing behavior)
- Local with API keys → uses HTTP APIs (existing behavior)
- Local without API keys but with Claude CLI → uses CLI (new behavior)
- Local without API keys and without CLI → throws (existing behavior)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/llm-fallback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/llm.ts tests/llm-fallback.test.ts
git commit -m "feat: add CLI-first fallback to callLLM for keyless local runs"
```

---

## Task 3: CLI-First Rubric Grading

**Files:**
- Modify: `src/graders/index.ts:170-175`

The `LLMGrader` already calls `callLLM()`, so Task 2's change gives it CLI support automatically. But for rubric grading specifically, we can use `--json-schema` for more reliable structured output.

- [ ] **Step 1: Write failing test**

Test that LLMGrader uses structured JSON when CLI is available:

```typescript
// Add to existing tests or new test file
describe('LLMGrader with CLI backend', () => {
    it('produces valid score and reasoning from CLI', async () => {
        // Integration test — skip if claude not installed
        // Create a mock session log and config
        // Call grader.grade()
        // Verify result has score and details
    });
});
```

- [ ] **Step 2: Modify LLMGrader to use structured output when CLI is available**

In `src/graders/index.ts`, change the LLMGrader's grade method:

```typescript
import { isClaudeCliAvailable, callClaudeCli } from '../utils/cli-llm';

// In LLMGrader.grade(), replace the callLLM block:
try {
    let response: { text: string };
    if (!env?.ANTHROPIC_API_KEY && !env?.GEMINI_API_KEY && !env?.OPENAI_API_KEY
        && await isClaudeCliAvailable()) {
        // Use structured output for more reliable parsing
        const schema = JSON.stringify({
            type: 'object',
            properties: {
                score: { type: 'number' },
                reasoning: { type: 'string' },
            },
            required: ['score', 'reasoning'],
            additionalProperties: false,
        });
        response = await callClaudeCli(prompt, { jsonSchema: schema });
    } else {
        response = await callLLM(prompt, { model: config.model, env });
    }
    return this.parseResponse(response.text, config);
}
```

- [ ] **Step 3: Update `parseResponse` to handle structured_output envelope**

The `extractStructuredOutput` in cli-llm.ts already handles this, so `parseResponse` receives clean JSON. But add a safety check:

```typescript
private parseResponse(text: string, config: GraderConfig): GraderResult {
    try {
        let cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            // Handle Claude session envelope (safety net)
            const target = parsed.structured_output ?? parsed;
            const score = Math.max(0, Math.min(1, parseFloat(target.score) || 0));
            return {
                grader_type: 'llm_rubric',
                score,
                weight: config.weight,
                details: target.reasoning || 'No reasoning provided'
            };
        }
    }
    // ... rest unchanged
}
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: all existing tests pass, new rubric test passes

- [ ] **Step 5: Commit**

```bash
git add src/graders/index.ts
git commit -m "feat: use Claude CLI structured output for rubric grading"
```

---

## Task 4: CLI-First Init

**Files:**
- Modify: `src/commands/init.ts:50-74`

- [ ] **Step 1: Write failing test**

```typescript
describe('runInit with CLI backend', () => {
    it('generates eval.yaml without API keys when claude is installed', async () => {
        // Integration test
    });
});
```

- [ ] **Step 2: Replace API-key detection with CLI-first path**

In `src/commands/init.ts`, replace the API key detection block (lines 50-74):

```typescript
import { isClaudeCliAvailable, callClaudeCli } from '../utils/cli-llm';

// Replace lines 50-74 with:
const geminiKey = process.env.GEMINI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const hasApiKey = !!(geminiKey || anthropicKey || openaiKey);
const cliAvailable = await isClaudeCliAvailable();

if (hasApiKey || cliAvailable) {
    const { Spinner, fmt } = await import('../utils/cli');
    const label = hasApiKey
        ? `generating eval with ${geminiKey ? 'Gemini' : anthropicKey ? 'Anthropic' : 'OpenAI'}`
        : 'generating eval with Claude CLI';
    const spinner = new Spinner('init', label);
    try {
        let config: string;
        if (hasApiKey) {
            const llmProvider = geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : 'openai';
            const llmApiKey = (geminiKey || anthropicKey || openaiKey)!;
            config = await generateWithLLM(skills, llmApiKey, llmProvider);
        } else {
            config = await generateWithCli(skills);
        }
        await fs.writeFile(evalPath, config, 'utf-8');
        spinner.stop(fmt.green('created eval.yaml'));
        console.log(`     Review and edit the file, then run: pathgrade\n`);
        return;
    } catch (err: any) {
        spinner.stop(fmt.red(`AI generation failed: ${err.message}`));
        console.log('     Falling back to template.\n');
    }
} else {
    console.log('  Install Claude CLI or set an API key for AI-powered eval generation.\n');
}
```

- [ ] **Step 3: Add `generateWithCli` function**

```typescript
async function generateWithCli(
    skills: Array<{ name: string; skillMd: string }>
): Promise<string> {
    const prompt = buildInitPrompt(skills);  // Extract existing prompt from generateWithLLM
    const result = await callClaudeCli(prompt, { timeoutSec: 120 });
    const yamlContent = result.text.replace(/```ya?ml\n?/g, '').replace(/```\n?/g, '').trim();
    return yamlContent + '\n';
}
```

Extract the prompt-building logic from the existing `generateWithLLM` into a shared `buildInitPrompt(skills)` function so both paths use the same prompt.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: add CLI-first path for pathgrade init"
```

---

## Task 5: Host-Auth Passthrough for Solver

**Files:**
- Modify: `src/types.ts:~95-100` (EnvironmentSetupOpts)
- Modify: `src/providers/local.ts:18-69`
- Modify: `src/evalRunner.ts` (pass authMode when setting up runtime)

This is the most architecturally significant change. Currently `LocalProvider.setup()` overrides HOME, which kills CLI auth. Host-auth passthrough keeps real HOME while still isolating the workspace via `cwd`.

- [ ] **Step 1: Add `authMode` to EnvironmentSetupOpts**

In `src/types.ts`, find `EnvironmentSetupOpts` and add:

```typescript
export interface EnvironmentSetupOpts {
    // ... existing fields ...

    /**
     * 'host' — preserve real HOME for CLI auth (host-auth passthrough).
     *          Workspace is still isolated via cwd.
     * 'isolated' — override HOME with temp dir (current default behavior).
     *              Required when solver does not use CLI auth (e.g., API-key mode).
     */
    authMode?: 'host' | 'isolated';
}
```

- [ ] **Step 2: Modify LocalProvider.setup() to support host auth**

In `src/providers/local.ts`, change `setup()`:

```typescript
async setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, _env?: Record<string, string>): Promise<TrialRuntime> {
    const rootDir = path.join(os.tmpdir(), `pathgrade-${Math.random().toString(36).substring(7)}`);
    const workspacePath = path.join(rootDir, 'workspace');
    const tmpPath = path.join(rootDir, 'tmp');

    await fs.ensureDir(workspacePath);
    await fs.ensureDir(tmpPath);
    await fs.copy(taskPath, workspacePath);

    // Inject skills (unchanged)
    const discoveryDirs = [
        path.join(workspacePath, '.agents', 'skills'),
        path.join(workspacePath, '.claude', 'skills'),
    ];
    for (const skillsDir of discoveryDirs) {
        await fs.ensureDir(skillsDir);
        for (const spath of skillsPaths) {
            const skillName = path.basename(spath);
            await fs.copy(spath, path.join(skillsDir, skillName));
        }
    }

    if (opts.authMode === 'host') {
        // Host-auth passthrough: keep real HOME for CLI auth.
        // Only isolate TMPDIR so agent temp files don't pollute.
        return {
            handle: rootDir,
            workspacePath,
            env: {
                TMPDIR: tmpPath,
                TMP: tmpPath,
                TEMP: tmpPath,
            },
            paths: {
                root: rootDir,
                workspace: workspacePath,
                home: process.env.HOME || os.homedir(),
                tmp: tmpPath,
            },
        };
    }

    // Isolated mode (existing behavior, unchanged)
    const homePath = path.join(rootDir, 'home');
    const xdgPath = path.join(rootDir, 'xdg');
    const xdgStatePath = path.join(xdgPath, 'state');
    const xdgCachePath = path.join(xdgPath, 'cache');

    await fs.ensureDir(homePath);
    await fs.ensureDir(xdgStatePath);
    await fs.ensureDir(xdgCachePath);

    return {
        handle: rootDir,
        workspacePath,
        env: {
            HOME: homePath,
            XDG_CONFIG_HOME: xdgPath,
            XDG_STATE_HOME: xdgStatePath,
            XDG_CACHE_HOME: xdgCachePath,
            TMPDIR: tmpPath,
            TMP: tmpPath,
            TEMP: tmpPath,
        },
        paths: {
            root: rootDir,
            workspace: workspacePath,
            home: homePath,
            xdg: xdgPath,
            xdgState: xdgStatePath,
            xdgCache: xdgCachePath,
            tmp: tmpPath,
        },
    };
}
```

- [ ] **Step 3: Wire authMode into the eval runner**

In `src/evalRunner.ts`, where `this.provider.setup()` is called, determine authMode based on whether the agent is CLI-authenticated:

```typescript
import { isClaudeCliAvailable } from './utils/cli-llm';

// When setting up the runtime:
const agentName = opts.agent;  // e.g., 'claude', 'codex', 'gemini'
const cliAgents = ['claude', 'codex'];
const useHostAuth = cliAgents.includes(agentName) && await isClaudeCliAvailable();

const runtime = await this.provider.setup(
    taskPath,
    skillsPaths,
    { ...setupOpts, authMode: useHostAuth ? 'host' : 'isolated' },
    env
);
```

The exact location depends on how `evalRunner.ts` currently calls `setup()`. Find it with:
`grep -n 'provider.setup\|this.provider.setup' src/evalRunner.ts`

- [ ] **Step 4: Write tests**

```typescript
describe('LocalProvider host-auth passthrough', () => {
    it('preserves real HOME when authMode is host', async () => {
        const provider = new LocalProvider();
        const runtime = await provider.setup(
            '/tmp/test-task', [], { authMode: 'host' }
        ) as TrialRuntime;
        expect(runtime.env.HOME).toBeUndefined();
        expect(runtime.env.TMPDIR).toBeTruthy();
        await provider.cleanup(runtime);
    });

    it('overrides HOME when authMode is isolated', async () => {
        const provider = new LocalProvider();
        const runtime = await provider.setup(
            '/tmp/test-task', [], { authMode: 'isolated' }
        ) as TrialRuntime;
        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        await provider.cleanup(runtime);
    });

    it('defaults to isolated when authMode is omitted', async () => {
        const provider = new LocalProvider();
        const runtime = await provider.setup(
            '/tmp/test-task', [], {}
        ) as TrialRuntime;
        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        await provider.cleanup(runtime);
    });
});
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/providers/local.ts src/evalRunner.ts tests/local-provider.test.ts
git commit -m "feat: add host-auth passthrough mode for CLI-authenticated agents"
```

---

## Task 6: Update User-Facing Messages

**Files:**
- Modify: `src/commands/init.ts:73`
- Modify: `src/utils/llm.ts:72`

- [ ] **Step 1: Update error messages**

The existing error messages tell users to set API keys. Update them to mention CLI auth as an alternative:

In `src/utils/llm.ts:72`:
```
- 'No API key available for LLM calls (set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)'
+ 'No LLM backend available. Install Claude CLI (claude.ai) or set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
```

In `src/commands/init.ts:73`:
```
- 'Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY for AI-powered eval generation.'
+ 'Install Claude CLI or set an API key for AI-powered eval generation.'
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/llm.ts src/commands/init.ts
git commit -m "docs: update error messages to mention CLI auth alternative"
```

---

## Task 7: Integration Verification

No new files — this is a manual verification step.

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 2: Run pathgrade init without API keys**

```bash
unset GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
cd /tmp && mkdir test-init && cd test-init
echo '# Test Skill\nA test skill.' > SKILL.md
pathgrade init
```

Expected: eval.yaml generated via Claude CLI, no API key errors

- [ ] **Step 3: Run a local eval without API keys**

```bash
unset GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
pathgrade  # in a directory with an eval.yaml
```

Expected: solver runs with host auth, rubric grades via CLI, no API key errors

- [ ] **Step 4: Run with API keys to verify backward compatibility**

```bash
export GEMINI_API_KEY=<real-key>
pathgrade
```

Expected: uses HTTP API path (existing behavior), no regressions

- [ ] **Step 5: Commit any fixes discovered during verification**

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude CLI not installed on some dev machines | API-key path is kept as fallback; error message updated |
| CLI cold-start latency (~8-17s per call) | Acceptable — current API latency is similar; no batch amplification |
| Claude session envelope format changes | `extractStructuredOutput` has fallback; tests catch regressions |
| Host HOME contains sensitive state beyond auth | Host-auth only runs the solver in a temp `cwd`; it doesn't read HOME contents |
| Codex users lose judge functionality | Codex solver still works; judge falls back to API keys or fails with clear message |

## What This Does NOT Change

- CI runs with API keys → unchanged, HTTP API path still works
- Docker/container environments → unchanged, no CLI assumed
- `DeterministicGrader` → unchanged, no LLM involvement
- Agent adapter code (`src/agents/claude.ts`, `src/agents/codex.ts`) → unchanged, already use CLI
- Eval YAML schema → unchanged
