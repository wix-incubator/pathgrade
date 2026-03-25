# CLI-First Local LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Pathgrade's API-key-backed local LLM calls with Claude CLI subprocess calls using the host's existing OAuth session, so local runs need zero provider API keys.

**Architecture:** Add a `callClaudeCli()` function that shells out to `claude -p` with appropriate flags. Wire it into `callLLM()` as a first-choice backend when Claude CLI is available, with the existing API-key path kept as fallback for CI. `callLLM()` is the single CLI detection point — all callers (grader, persona, init) go through it. For the solver, add a host-auth passthrough mode to `LocalProvider` that preserves real HOME while still isolating the workspace via `cwd`.

**Tech Stack:** Node.js `child_process.spawn`, existing TypeScript codebase (CommonJS).

**Evidence:** POC results in `docs/cli-poc/claude-results.json`. CLI flag verification in `docs/cli-poc/2026-03-25-cli-flag-verification.md` (Task 0 — completed).

---

## Scope

This plan covers the three judge call surfaces plus the solver auth passthrough:

| Call surface | Current implementation | New implementation |
|---|---|---|
| Rubric grading | `src/graders/index.ts:171` → `callLLM()` → HTTP API | `callLLM({ jsonSchema })` → `callClaudeCli()` with `--json-schema` |
| Persona generation | `src/persona.ts:69` → `callLLM()` → HTTP API | `callLLM()` → `callClaudeCli()` in text mode (implicit via Task 2) |
| Init generation | `src/commands/init.ts:63` → `generateWithLLM()` → HTTP API | `generateWithCli()` → `callClaudeCli()` in text mode |
| Solver auth | `src/providers/local.ts:51` overrides HOME → kills CLI auth | Host-auth passthrough: preserve real HOME |

**Persona coverage note:** `src/persona.ts:69` calls `callLLM(prompt, { model, env })`. Task 2's change to `callLLM()` gives persona CLI support automatically. When `persona.model` specifies a non-Claude model (e.g., `gemini-flash`) but no API key is available, the CLI path logs a warning and falls through — see Task 2 Step 3 for the model-guard logic.

**Not in scope:** Codex judge flows (flaky), generic bridge, cross-platform claims, CI changes.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/cli-llm.ts` | Create | Claude CLI subprocess wrapper: detection, invocation, envelope parsing |
| `src/utils/llm.ts` | Modify | Add `'cli'` to provider union, add `jsonSchema` to opts, try CLI first, fall back to API keys |
| `src/commands/init.ts` | Modify | Replace `generateWithLLM()` with CLI-first path |
| `src/providers/local.ts` | Modify | Add host-auth passthrough mode |
| `src/types.ts` | Modify | Make `xdg`/`xdgState`/`xdgCache` optional in `TrialPaths`; add `authMode` to `EvalRunOptions` |
| `src/evalRunner.ts` | Modify | Pass `authMode` through to provider setup |
| `src/commands/run.ts` | Modify | Determine `authMode` from agent name + CLI availability |
| `tests/cli-llm.test.ts` | Create | Unit tests for CLI wrapper + integration smoke test |
| `tests/llm-fallback.test.ts` | Create | Tests for CLI-first → API-key fallback logic |

---

## Task 0: CLI Flag Verification

**Purpose:** Verify all CLI flag assumptions before implementation. The POC `docs/cli-poc/claude-results.json` contains raw results but the flag behaviors assumed by this plan must be confirmed with `child_process.spawn` (no shell).

- [x] **Step 1: Verify `--output-format text` with `-p` mode**

```bash
# From Node.js spawn (no shell):
node -e "
const { spawn } = require('child_process');
const child = spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence']);
child.stdin.write('Reply with exactly: hello');
child.stdin.end();
let out = '';
child.stdout.on('data', d => out += d);
child.on('close', code => console.log('exit:', code, 'stdout:', JSON.stringify(out)));
"
```

Expected: exit 0, stdout contains "hello"

- [x] **Step 2: Verify `--output-format json` + `--json-schema` with spawn**

```bash
node -e "
const { spawn } = require('child_process');
const schema = JSON.stringify({type:'object',properties:{answer:{type:'string'}},required:['answer']});
const child = spawn('claude', ['-p', '--output-format', 'json', '--json-schema', schema, '--no-session-persistence']);
child.stdin.write('What is 2+2? Put the answer in the answer field.');
child.stdin.end();
let out = '';
child.stdout.on('data', d => out += d);
child.on('close', code => {
    console.log('exit:', code);
    const parsed = JSON.parse(out);
    console.log('has structured_output:', !!parsed.structured_output);
    console.log('envelope keys:', Object.keys(parsed));
});
"
```

Expected: exit 0, envelope has `structured_output` with `answer` field

- [x] **Step 3: Verify tool disabling in `-p` mode**

Test whether `-p` mode already disables tools (making `--tools ""` unnecessary):

```bash
# Test 1: -p mode without --tools flag
node -e "
const { spawn } = require('child_process');
const child = spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence']);
child.stdin.write('What is 2+2?');
child.stdin.end();
let out = '';
child.stdout.on('data', d => out += d);
child.on('close', code => console.log('exit:', code, 'length:', out.length));
"

# Test 2: -p mode with --allowedTools '[]' (if --tools "" fails)
node -e "
const { spawn } = require('child_process');
const child = spawn('claude', ['-p', '--output-format', 'text', '--no-session-persistence', '--allowedTools', '']);
child.stdin.write('What is 2+2?');
child.stdin.end();
let out = '';
child.stdout.on('data', d => out += d);
child.on('close', code => console.log('exit:', code, 'length:', out.length));
"
```

Document which approach works. If `-p` mode already disables tools, omit the flag entirely.

- [x] **Step 4: Verify `claude auth status` exit codes**

```bash
# When authenticated:
node -e "
const { spawn } = require('child_process');
const child = spawn('claude', ['auth', 'status']);
let out = '', err = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => err += d);
child.on('close', code => console.log('exit:', code, 'stdout:', out.trim(), 'stderr:', err.trim()));
"
```

Verify: authenticated → exit 0, not authenticated → exit non-zero. If exit code is unreliable, fall back to the canary approach (a cheap `-p` call as the availability check).

- [x] **Step 5: Document results**

Results recorded in `docs/cli-poc/2026-03-25-cli-flag-verification.md`. All assumptions confirmed:
- `-p` mode disables tools — no `--tools` flag needed
- `--json-schema` accepts inline JSON via spawn, envelope has `structured_output`
- `auth status` returns JSON with `loggedIn` field, exit 0 when authenticated
- Bonus: `auth status` JSON output enables a secondary `loggedIn: true` check

---

## Task 1: Claude CLI Wrapper

**Files:**
- Create: `src/utils/cli-llm.ts`
- Test: `tests/cli-llm.test.ts`

- [x] **Step 1: Write failing test for `isClaudeCliAvailable`**

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

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-llm.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Implement `isClaudeCliAvailable` and `callClaudeCli`**

```typescript
// src/utils/cli-llm.ts
import { spawn } from 'child_process';

// Import only the type to avoid circular dependency.
// The actual LLMCallResult interface is in llm.ts — cli-llm.ts defines
// its own return type that is structurally compatible.
export interface CliLLMResult {
    text: string;
    provider: 'cli';
    model: string;
}

// --- Availability check with promise-based dedup ---

let availabilityPromise: Promise<boolean> | null = null;

/**
 * Check if claude CLI is installed and authenticated.
 * Result is cached for the process lifetime.
 * Uses a promise-based lock so concurrent callers share one check
 * (avoids N parallel `claude auth status` subprocesses on startup).
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
    if (availabilityPromise !== null) return availabilityPromise;
    availabilityPromise = checkCliAvailability();
    return availabilityPromise;
}

async function checkCliAvailability(): Promise<boolean> {
    try {
        // Timeout reduced to 5s — auth status should be near-instant.
        // If exit code behavior changes in future CLI versions,
        // callClaudeCli will fail on first real use and the error
        // propagates to the caller with a clear message.
        const result = await runCli('claude', ['auth', 'status'], {}, 5);
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

/** Reset the availability cache (for testing). */
export function resetCliCache(): void {
    availabilityPromise = null;
}

// --- CLI invocation ---

export interface CliLLMOpts {
    jsonSchema?: string;
    model?: string;
    timeoutSec?: number;
}

/**
 * Call Claude CLI in print mode.
 *
 * For rubric-style calls, pass jsonSchema to get structured JSON output.
 * For text-style calls (persona, init), omit jsonSchema.
 *
 * Uses --no-session-persistence to avoid session file accumulation.
 * In -p (print) mode, tools are already disabled — no --tools flag needed.
 * (Verified in Task 0 Step 3.)
 *
 * NEVER uses --bare (disables OAuth) or --dangerously-skip-permissions
 * (only appropriate for solver, not judge flows).
 */
export async function callClaudeCli(
    prompt: string,
    opts: CliLLMOpts = {}
): Promise<CliLLMResult> {
    const args = ['-p', '--no-session-persistence'];

    if (opts.model) {
        args.push('--model', opts.model);
    }

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
        provider: 'cli',
        model: opts.model || 'claude-cli',
    };
}

/**
 * Claude's --output-format json wraps the response in a session envelope:
 * {"type":"result",...,"structured_output":{...},"result":"..."}
 *
 * For --json-schema calls, the actual response is in structured_output.
 * This function is only called for JSON-mode output (not text mode).
 *
 * Uses regex extraction as a safety net in case stdout contains debug
 * lines before the JSON envelope (same pattern as DeterministicGrader
 * at src/graders/index.ts:40).
 */
function extractStructuredOutput(raw: string): string {
    // Try to extract the outermost JSON object from stdout
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.warn('[cli-llm] extractStructuredOutput: no JSON found in stdout, returning raw');
        return raw.trim();
    }

    try {
        const envelope = JSON.parse(jsonMatch[0]);
        if (envelope.structured_output && typeof envelope.structured_output === 'object') {
            return JSON.stringify(envelope.structured_output);
        }
        if (typeof envelope.result === 'string' && envelope.result) {
            return envelope.result;
        }
        // No envelope fields — return the parsed JSON as-is
        // (handles case where CLI returns raw JSON without envelope)
        return jsonMatch[0];
    } catch {
        console.warn('[cli-llm] extractStructuredOutput: JSON parse failed, returning raw match');
        return jsonMatch[0];
    }
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
            // Use callback to handle backpressure on large prompts
            // (rubric grading transcripts can be 50KB+)
            child.stdin.write(stdin, () => child.stdin.end());
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
- No `--tools` flag — `-p` mode already disables tools (verified in Task 0 Step 3)
- `--no-session-persistence` prevents session accumulation
- No `--bare` (disables OAuth), no `--dangerously-skip-permissions` (solver only)
- `--model` flag forwarded from `callLLM()` opts when specified
- `provider: 'cli'` — distinct from `'anthropic'` to avoid semantic confusion with the HTTP API path (see `LLMCallResult` type change in Task 2)
- Envelope parsing uses regex extraction as safety net (same pattern as `DeterministicGrader` at `src/graders/index.ts:40`)
- Promise-based availability cache prevents thundering-herd on parallel trial startup
- `stdin.write(stdin, callback)` handles backpressure for large prompts
- The existing Claude agent adapter (`src/agents/claude.ts:31`) already passes `--dangerously-skip-permissions` for solver runs — no change needed there

- [x] **Step 4: Write additional tests**

```typescript
import { describe, it, expect } from 'vitest';
import {
    isClaudeCliAvailable,
    callClaudeCli,
    resetCliCache,
} from '../src/utils/cli-llm';
// Export extractStructuredOutput for unit testing
import { extractStructuredOutput } from '../src/utils/cli-llm';

describe('callClaudeCli', () => {
    it('returns text for plain prompt', async () => {
        // Integration test — skip if claude not installed
        if (!await isClaudeCliAvailable()) return;
        const result = await callClaudeCli('Reply with exactly: hello');
        expect(result.text).toBeTruthy();
        expect(result.provider).toBe('cli');
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
    it('extracts structured_output from Claude envelope', () => {
        const envelope = JSON.stringify({
            type: 'result',
            structured_output: { score: 0.8, reasoning: 'good' },
            result: 'fallback text',
        });
        const result = extractStructuredOutput(envelope);
        expect(JSON.parse(result)).toEqual({ score: 0.8, reasoning: 'good' });
    });

    it('falls back to result field when structured_output is absent', () => {
        const envelope = JSON.stringify({
            type: 'result',
            result: 'plain text response',
        });
        const result = extractStructuredOutput(envelope);
        expect(result).toBe('plain text response');
    });

    it('handles stdout with prefix text before JSON', () => {
        const raw = 'Some debug line\n{"type":"result","structured_output":{"answer":"4"}}';
        const result = extractStructuredOutput(raw);
        expect(JSON.parse(result)).toEqual({ answer: '4' });
    });

    it('returns raw when no JSON found', () => {
        const result = extractStructuredOutput('not json at all');
        expect(result).toBe('not json at all');
    });
});
```

- [x] **Step 5: Run tests**

Run: `npx vitest run tests/cli-llm.test.ts`
Expected: PASS (unit tests always, integration tests when claude installed)

- [x] **Step 6: Commit**

```bash
git add src/utils/cli-llm.ts tests/cli-llm.test.ts
git commit -m "feat: add Claude CLI subprocess wrapper for local LLM calls"
```

---

## Task 2: CLI-First Fallback in callLLM (with jsonSchema support)

**Files:**
- Modify: `src/utils/llm.ts`
- Test: `tests/llm-fallback.test.ts`

This task is the **single point of CLI detection**. All callers (grader, persona, init helper) go through `callLLM()`. No other file should import `isClaudeCliAvailable` or `callClaudeCli` directly for judge flows.

This change also covers persona generation (`src/persona.ts:69`) since it calls `callLLM()`.

- [x] **Step 1: Add `'cli'` to `LLMCallResult.provider` union and `jsonSchema` to opts**

In `src/utils/llm.ts`, update the types:

```typescript
export interface LLMCallOptions {
    model?: string;
    env?: Record<string, string>;
    temperature?: number;
    /** When set, use --json-schema for structured output via CLI. */
    jsonSchema?: string;
}

export interface LLMCallResult {
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    provider: 'gemini' | 'anthropic' | 'openai' | 'cli';
    model: string;
}
```

- [x] **Step 2: Write failing tests**

```typescript
// tests/llm-fallback.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callLLM } from '../src/utils/llm';

// Mock the cli-llm module
vi.mock('../src/utils/cli-llm', () => ({
    isClaudeCliAvailable: vi.fn(),
    callClaudeCli: vi.fn(),
}));

import { isClaudeCliAvailable, callClaudeCli } from '../src/utils/cli-llm';

const mockIsAvailable = vi.mocked(isClaudeCliAvailable);
const mockCallCli = vi.mocked(callClaudeCli);

describe('callLLM CLI-first fallback', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('tries CLI when no API keys are available and claude is installed', async () => {
        mockIsAvailable.mockResolvedValue(true);
        mockCallCli.mockResolvedValue({ text: 'hello', provider: 'cli', model: 'claude-cli' });

        const result = await callLLM('test prompt', { env: {} });
        expect(mockCallCli).toHaveBeenCalledWith('test prompt', {});
        expect(result.provider).toBe('cli');
    });

    it('falls back to API keys when CLI is not available', async () => {
        mockIsAvailable.mockResolvedValue(false);
        // This will throw because no API keys — that's expected
        await expect(callLLM('test', { env: {} })).rejects.toThrow();
        expect(mockCallCli).not.toHaveBeenCalled();
    });

    it('uses API keys directly when explicitly provided in env', async () => {
        // When env has ANTHROPIC_API_KEY, skip CLI even if available
        mockIsAvailable.mockResolvedValue(true);
        // This will use the HTTP path — mock fetch or expect the call
        // to NOT go through callClaudeCli
    });

    it('skips CLI when opts.model specifies a non-Claude model', async () => {
        mockIsAvailable.mockResolvedValue(true);
        // model: 'gemini-flash' should NOT use CLI — it's not a Claude model
        // Without API keys this should throw, not silently substitute Claude
        await expect(callLLM('test', { model: 'gemini-flash', env: {} })).rejects.toThrow();
        expect(mockCallCli).not.toHaveBeenCalled();
    });

    it('forwards jsonSchema to callClaudeCli', async () => {
        mockIsAvailable.mockResolvedValue(true);
        const schema = '{"type":"object"}';
        mockCallCli.mockResolvedValue({ text: '{}', provider: 'cli', model: 'claude-cli' });

        await callLLM('test', { env: {}, jsonSchema: schema });
        expect(mockCallCli).toHaveBeenCalledWith('test', { jsonSchema: schema });
    });

    it('forwards opts.model to callClaudeCli when it is a Claude model', async () => {
        mockIsAvailable.mockResolvedValue(true);
        mockCallCli.mockResolvedValue({ text: 'hi', provider: 'cli', model: 'claude-sonnet-4' });

        await callLLM('test', { env: {}, model: 'claude-sonnet-4-20250514' });
        expect(mockCallCli).toHaveBeenCalledWith('test', { model: 'claude-sonnet-4-20250514' });
    });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/llm-fallback.test.ts`

- [x] **Step 4: Modify `callLLM` to try CLI first**

In `src/utils/llm.ts`, change the `callLLM` function:

```typescript
// Add import at top of file:
import { isClaudeCliAvailable, callClaudeCli, CliLLMResult } from './cli-llm';

export async function callLLM(prompt: string, opts: LLMCallOptions = {}): Promise<LLMCallResult> {
    const keys = getApiKeys(opts.env);
    const hasExplicitKey = Object.values(keys).some(Boolean);

    // CLI-first: when no API keys are available, try Claude CLI.
    // This must fire BEFORE getProviderSequence(), because getProviderSequence
    // throws when a model is explicitly requested (e.g., "claude-3-5-sonnet")
    // but no matching key exists. In keyless CLI mode, that throw is wrong —
    // the CLI handles auth via OAuth, not via API key env vars.
    if (!hasExplicitKey && await isClaudeCliAvailable()) {
        // Guard: if opts.model specifies a non-Claude model, don't silently
        // substitute Claude. The user explicitly asked for a different provider.
        const requestedProvider = inferProviderFromModel(opts.model);
        if (requestedProvider && requestedProvider !== 'anthropic') {
            // Non-Claude model requested but no API key for it — throw
            // rather than silently using Claude CLI.
            throw new Error(
                `No API key for model "${opts.model}". ` +
                `CLI fallback only supports Claude models. ` +
                `Set ${requestedProvider === 'gemini' ? 'GEMINI_API_KEY' : requestedProvider === 'openai' ? 'OPENAI_API_KEY' : 'the appropriate API key'}.`
            );
        }

        // Build CLI options — forward model and jsonSchema
        const cliOpts: Record<string, string | undefined> = {};
        if (opts.model) cliOpts.model = opts.model;
        if (opts.jsonSchema) cliOpts.jsonSchema = opts.jsonSchema;

        const cliResult = await callClaudeCli(prompt, cliOpts);
        return {
            text: cliResult.text,
            provider: 'cli',
            model: cliResult.model,
        };
    }

    // Existing API-key path (CI, explicit provider keys)
    const providers = getProviderSequence(opts.model, opts.env);
    const temperature = opts.temperature ?? 0;

    for (const provider of providers) {
        const apiKey = keys[provider];
        if (!apiKey) {
            continue;
        }

        const model = opts.model || getDefaultModel(provider);

        if (provider === 'gemini') {
            return await callGemini(prompt, apiKey, model, temperature);
        }
        if (provider === 'anthropic') {
            return await callAnthropic(prompt, apiKey, model, temperature);
        }
        return await callOpenAI(prompt, apiKey, model, temperature, opts.env);
    }

    throw new Error(
        'No LLM backend available. Install Claude CLI (claude.ai) or set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
    );
}
```

This ordering is critical: `getProviderSequence()` must never be called in keyless-CLI mode because it throws on `inferProviderFromModel("claude-sonnet-...")` when `ANTHROPIC_API_KEY` is absent. The CLI-first check short-circuits before that code path.

This preserves full backward compatibility:
- CI with API keys → uses HTTP APIs (existing behavior)
- Local with API keys → uses HTTP APIs (existing behavior)
- Local without API keys but with Claude CLI → uses CLI (new behavior)
- Local without API keys and without CLI → throws (existing behavior)
- Non-Claude model requested without API key → throws with clear message (not silent substitution)

- [x] **Step 5: Run tests**

Run: `npx vitest run tests/llm-fallback.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/utils/llm.ts tests/llm-fallback.test.ts
git commit -m "feat: add CLI-first fallback to callLLM with jsonSchema support"
```

---

## Task 3: CLI-First Init

**Files:**
- Modify: `src/commands/init.ts`

- [x] **Step 1: Write failing test**

```typescript
describe('runInit with CLI backend', () => {
    it('generates eval.yaml without API keys when claude is installed', async () => {
        // Integration test
    });
});
```

- [x] **Step 2: Extract `buildInitPrompt` from `generateWithLLM`**

The existing `generateWithLLM` at `src/commands/init.ts:134-289` has a 70-line inline prompt (lines 143-214) interleaved with provider-specific API call logic. This extraction is non-trivial because:
- The prompt references `skillSummaries` built at lines 139-141
- The function has three provider branches (Anthropic: 219, OpenAI: 243, Gemini: 266)
- Temperature and fetch options are provider-specific

Extract the prompt into a standalone function:

```typescript
/**
 * Build the init prompt for eval.yaml generation.
 * Shared by both the API-key path (generateWithLLM) and CLI path (generateWithCli).
 */
function buildInitPrompt(skills: Array<{ name: string; skillMd: string }>): string {
    const skillSummaries = skills.map(s =>
        `## Skill: ${s.name}\n\n${s.skillMd}`
    ).join('\n\n---\n\n');

    // This is the full prompt from lines 143-214 of generateWithLLM.
    // Copy it EXACTLY — do not modify the prompt text.
    return `You are an expert at creating evaluation tasks for AI agent skills.

Given the following skill definition(s), generate an eval.yaml file that defines 1-2 evaluation tasks to test whether an AI agent correctly discovers and uses the skill.

For each task:
- Write a realistic instruction (what a user would ask the agent to do)
- Define workspace files if needed (fixture files the agent works on)
- Write a deterministic grader (shell script that outputs JSON to stdout)
- Write an LLM rubric (criteria for the LLM judge)

IMPORTANT GRADING RULES:
- Deterministic graders MUST output JSON to stdout: {"score": 0.0-1.0, "details": "...", "checks": [...]}
- Do NOT use exit codes for scoring. The grader should always exit 0 and report the score in JSON.
- Use awk for floating point arithmetic (bc is not available in node:20-slim).
- The "checks" array is optional but recommended for per-check breakdown.
- For workspace files, only reference files that exist in the skill directory or that the agent will create.

CRITICAL — FILENAME CONSISTENCY:
- The instruction MUST tell the agent exactly what filenames to create (e.g., "Save the result as output.txt").
- The deterministic grader MUST only check for filenames that are explicitly mentioned in the instruction.
- NEVER check for a hardcoded filename that the instruction does not mention — the agent will choose its own names and the grader will fail.
- Example: if the grader checks for "output.html", the instruction must say "Save the HTML file as output.html".

${skillSummaries}

Respond with ONLY the eval.yaml content. Use this exact format:
` + '...(YAML template block — copy lines 170-214 exactly)...';
}
```

Then update `generateWithLLM` to call it:

```typescript
async function generateWithLLM(
  skills: Array<{ name: string; skillMd: string }>,
  apiKey: string,
  provider: 'gemini' | 'anthropic' | 'openai' = 'gemini'
): Promise<string> {
  const prompt = buildInitPrompt(skills);
  // ... rest of the function unchanged (provider-specific API calls)
}
```

**Verification:** After extraction, run `npx vitest run` to confirm existing tests still pass — the prompt content must be identical.

- [x] **Step 3: Replace API-key detection with CLI-first path**

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

- [x] **Step 4: Add `generateWithCli` function**

```typescript
async function generateWithCli(
    skills: Array<{ name: string; skillMd: string }>
): Promise<string> {
    const prompt = buildInitPrompt(skills);
    const result = await callClaudeCli(prompt, { timeoutSec: 120 });
    const yamlContent = result.text.replace(/```ya?ml\n?/g, '').replace(/```\n?/g, '').trim();
    return yamlContent + '\n';
}
```

- [x] **Step 5: Run tests**

Run: `npx vitest run`

- [x] **Step 6: Commit**

```bash
git add src/commands/init.ts
git commit -m "feat: add CLI-first path for pathgrade init"
```

---

## Task 4: Host-Auth Passthrough for Solver

**Files:**
- Modify: `src/types.ts` (`TrialPaths`, `EvalRunOptions`)
- Modify: `src/providers/local.ts` (rename `_opts` → `opts`, add host-auth branch)
- Modify: `src/commands/run.ts` (determine `authMode` from agent name)
- Modify: `src/evalRunner.ts` (pass `authMode` through to provider)

This is the most architecturally significant change. Currently `LocalProvider.setup()` overrides HOME, which kills CLI auth. Host-auth passthrough keeps real HOME while still isolating the workspace via `cwd`.

**Architecture decision:** `authMode` is set by the CLI entry point (`src/commands/run.ts`), not by `EvalRunner`. This avoids the non-existent `opts.agent` issue — `run.ts` already has `agentName` at line 135, and it's the right place to make this decision.

- [x] **Step 1: Make XDG paths optional in `TrialPaths`**

In `src/types.ts`, update `TrialPaths`:

```typescript
export interface TrialPaths {
    root: string;
    workspace: string;
    home: string;
    xdg?: string;       // optional — absent in host-auth mode
    xdgState?: string;   // optional — absent in host-auth mode
    xdgCache?: string;   // optional — absent in host-auth mode
    tmp: string;
}
```

Audit: `TrialPaths` consumers access these via `runtime.paths?.xdg` (already optional-chained at `tests/providers.local.test.ts:41`). No other consumer accesses `xdg`/`xdgState`/`xdgCache` directly — they're only used in the `env` object returned by `setup()`.

- [x] **Step 2: Add `authMode` to `EvalRunOptions`**

In `src/evalRunner.ts`, add to `EvalRunOptions`:

```typescript
export interface EvalRunOptions {
    instruction?: string;
    conversation?: ResolvedConversation;
    graders: ResolvedGrader[];
    timeoutSec: number;
    graderModel?: string;
    graderTimeoutSec?: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    /** Set by the CLI entry point based on agent type + CLI availability. */
    authMode?: 'host' | 'isolated';
}
```

- [x] **Step 3: Pass `authMode` through `EvalRunner` to provider**

In `src/evalRunner.ts`, at line 212 where `this.provider.setup()` is called:

```typescript
// Line 212 currently:
// const runtime = await this.provider.setup(taskPath, skillsPaths, opts, env);

// Change to forward authMode:
const runtime = await this.provider.setup(
    taskPath,
    skillsPaths,
    { ...opts, authMode: opts.authMode },
    env
);
```

Note: `opts` is `EvalRunOptions` which already passes `timeoutSec` and `environment` — `EnvironmentSetupOpts` receives these correctly. Adding `authMode` as an optional field on `EnvironmentSetupOpts` keeps the interface compatible.

- [x] **Step 4: Add `authMode` to `EnvironmentSetupOpts`**

In `src/types.ts`:

```typescript
export interface EnvironmentSetupOpts {
    timeoutSec: number;
    environment: {
        cpus: number;
        memory_mb: number;
    };
    /**
     * 'host' — preserve real HOME for CLI auth (host-auth passthrough).
     *          Workspace is still isolated via cwd.
     * 'isolated' — override HOME with temp dir (current default behavior).
     */
    authMode?: 'host' | 'isolated';
}
```

- [x] **Step 5: Modify `LocalProvider.setup()` to support host auth**

In `src/providers/local.ts`, two changes:

**5a. Rename `_opts` → `opts`** (currently `_opts` at line 18 indicates unused; it's now used):

```typescript
// Line 18 — change _opts to opts:
async setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, _env?: Record<string, string>): Promise<TrialRuntime> {
```

**5b. Add host-auth branch** after the skills injection block (after line 46):

```typescript
    // ... existing skills injection code (lines 34-46) ...

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
                // xdg/xdgState/xdgCache omitted — now optional in TrialPaths
            },
        };
    }

    // Isolated mode (existing behavior, unchanged)
    const homePath = path.join(rootDir, 'home');
    // ... rest unchanged ...
```

Note: The `workspacePath` and `tmpPath` variables are created BEFORE the branch — move the `const rootDir`, `workspacePath`, `tmpPath`, `ensureDir`, and `copy` calls above the branch. The existing `homePath`/`xdgPath` declarations stay in the isolated branch only.

- [x] **Step 6: Set `authMode` in `src/commands/run.ts`**

In `src/commands/run.ts`, after `agentName` is determined (around line 147), add:

```typescript
import { isClaudeCliAvailable } from '../utils/cli-llm';

// After agentName is determined (line 147) and before evalOpts is built:
const cliAgents = ['claude', 'codex'];
const useHostAuth = cliAgents.includes(agentName) && await isClaudeCliAvailable();

// Then in evalOpts construction, add authMode:
const evalOpts: EvalRunOptions = opts.validate
    ? { /* ... existing validate opts ... */ authMode: useHostAuth ? 'host' : undefined }
    : {
        instruction: resolved.instruction,
        graders: filteredGraders,
        timeoutSec: resolved.timeout,
        graderModel: resolved.grader_model,
        environment: resolved.environment,
        authMode: useHostAuth ? 'host' : undefined,
      };
```

- [x] **Step 7: Write tests**

```typescript
// tests/local-provider-auth.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsExtra from 'fs-extra';
import { LocalProvider } from '../src/providers/local';
import { TrialRuntime } from '../src/types';

describe('LocalProvider host-auth passthrough', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        for (const dir of tempDirs) {
            if (await fsExtra.pathExists(dir)) {
                await fsExtra.remove(dir);
            }
        }
        tempDirs.length = 0;
    });

    // Helper to create a minimal task directory
    async function createTaskDir(): Promise<string> {
        const taskDir = path.join(os.tmpdir(), `pathgrade-test-${Date.now()}`);
        await fsExtra.ensureDir(taskDir);
        await fsExtra.writeFile(path.join(taskDir, 'task.toml'), 'name = "test"');
        tempDirs.push(taskDir);
        return taskDir;
    }

    // All required fields for EnvironmentSetupOpts
    const baseOpts = {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
    };

    it('preserves real HOME when authMode is host', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], { ...baseOpts, authMode: 'host' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeUndefined();
        expect(runtime.env.TMPDIR).toBeTruthy();
        expect(runtime.paths?.home).toBe(process.env.HOME || os.homedir());
        expect(runtime.paths?.xdg).toBeUndefined();
        await provider.cleanup(runtime);
    });

    it('overrides HOME when authMode is isolated', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], { ...baseOpts, authMode: 'isolated' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        expect(runtime.paths?.xdg).toBeTruthy();
        await provider.cleanup(runtime);
    });

    it('defaults to isolated when authMode is omitted', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], baseOpts
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        await provider.cleanup(runtime);
    });
});
```

- [x] **Step 8: Run full test suite**

Run: `npx vitest run`

- [x] **Step 9: Commit**

```bash
git add src/types.ts src/providers/local.ts src/evalRunner.ts src/commands/run.ts tests/local-provider-auth.test.ts
git commit -m "feat: add host-auth passthrough mode for CLI-authenticated agents"
```

---

## Task 5: Update User-Facing Messages

**Files:**
- Modify: `src/commands/init.ts:73`
- Modify: `src/utils/llm.ts:72` and `src/utils/llm.ts:202`

- [x] **Step 1: Update error messages**

The existing error messages tell users to set API keys. Update them to mention CLI auth as an alternative.

In `src/utils/llm.ts:72` (inside `getProviderSequence`):
```
- 'No API key available for LLM calls (set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)'
+ 'No LLM backend available. Install Claude CLI (claude.ai) or set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
```

In `src/utils/llm.ts:202` (end of `callLLM` provider loop — this is the second error path):
```
- 'No API key available for LLM calls (set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)'
+ 'No LLM backend available. Install Claude CLI (claude.ai) or set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.'
```

Note: After Task 2's changes, line 202 becomes unreachable in CLI mode (the CLI check short-circuits before the loop). But this message fires when the provider loop exhausts with API keys present (all providers fail), so it should still be updated for consistency.

In `src/commands/init.ts:73`:
```
- 'Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY for AI-powered eval generation.'
+ 'Install Claude CLI or set an API key for AI-powered eval generation.'
```

- [x] **Step 2: Commit**

```bash
git add src/utils/llm.ts src/commands/init.ts
git commit -m "docs: update error messages to mention CLI auth alternative"
```

---

## Task 6: Rubric Grading — Pass jsonSchema Through callLLM

**Files:**
- Modify: `src/graders/index.ts:170-175`

The `LLMGrader` already calls `callLLM()`, and Task 2 added `jsonSchema` support to `LLMCallOptions`. This task wires the grader to use structured output via the existing `callLLM()` path — **not** by importing `callClaudeCli` directly.

- [x] **Step 1: Add jsonSchema to the grader's `callLLM` call**

In `src/graders/index.ts`, at line 171 where `callLLM` is called:

```typescript
// Line 171 currently:
// const response = await callLLM(prompt, { model: config.model, env });

// Change to:
const rubricSchema = JSON.stringify({
    type: 'object',
    properties: {
        score: { type: 'number' },
        reasoning: { type: 'string' },
    },
    required: ['score', 'reasoning'],
    additionalProperties: false,
});
const response = await callLLM(prompt, {
    model: config.model,
    env,
    jsonSchema: rubricSchema,
});
```

Note: `jsonSchema` is only used by the CLI path inside `callLLM()`. When the API-key path is active, `jsonSchema` is ignored and the existing text-mode response + `parseResponse()` handles it. This is intentional — the API providers don't support `--json-schema`.

- [x] **Step 2: Run full test suite**

Run: `npx vitest run`

- [x] **Step 3: Commit**

```bash
git add src/graders/index.ts
git commit -m "feat: pass jsonSchema through callLLM for structured rubric grading"
```

---

## Task 7: Integration Verification

No new files — this is a manual verification step.

- [x] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

- [x] **Step 2: Run pathgrade init without API keys**

```bash
unset GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
cd /tmp && mkdir test-init && cd test-init
echo '# Test Skill\nA test skill.' > SKILL.md
pathgrade init
```

Expected: eval.yaml generated via Claude CLI, no API key errors

- [x] **Step 3: Run a local eval without API keys**

```bash
unset GEMINI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
pathgrade  # in a directory with an eval.yaml
```

Expected: solver runs with host auth, rubric grades via CLI, no API key errors

- [x] **Step 4: Run with API keys to verify backward compatibility**

```bash
export GEMINI_API_KEY=<real-key>
pathgrade
```

Expected: uses HTTP API path (existing behavior), no regressions

- [x] **Step 5: Commit any fixes discovered during verification**

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude CLI not installed on some dev machines | API-key path is kept as fallback; error message updated |
| CLI cold-start latency (~8-17s per call) | Acceptable — current API latency is similar; no batch amplification |
| Claude session envelope format changes | `extractStructuredOutput` has regex fallback + tests catch regressions |
| Host HOME contains sensitive state beyond auth | Host-auth only runs the solver in a temp `cwd`; it doesn't read HOME contents |
| API keys leak to agent in host-auth mode | Pre-existing: `runCommand` merges `process.env` in BOTH modes. Host-auth does not make this worse. Document as known limitation; future hardening can strip API key vars from the env merge. |
| Codex users lose judge functionality | Codex solver still works; judge falls back to API keys or fails with clear message |
| `claude auth status` exit code changes | Reduced timeout (5s), promise-based cache. If false positive occurs, `callClaudeCli` will fail on first real call with a clear error message. |
| Non-Claude model silently substituted by CLI | `callLLM` model guard checks `inferProviderFromModel(opts.model)` and throws if non-Claude model requested without API key |

## What This Does NOT Change

- CI runs with API keys → unchanged, HTTP API path still works
- Docker/container environments → unchanged, no CLI assumed
- `DeterministicGrader` → unchanged, no LLM involvement
- Agent adapter code (`src/agents/claude.ts`, `src/agents/codex.ts`) → unchanged, already use CLI
- Eval YAML schema → unchanged

## Review Findings Addressed

This plan revision addresses all 15 findings from the adversarial review (2 agents, Opus 4.6 + Sonnet 4.6):

| # | Finding | Fix |
|---|---------|-----|
| 1 | `opts.agent` doesn't exist in `EvalRunOptions` | `authMode` set in `run.ts` (has `agentName`), passed through `EvalRunOptions` → Task 4 |
| 2 | Test code missing required `EnvironmentSetupOpts` fields | Tests include `timeoutSec` + `environment` → Task 4 Step 7 |
| 3 | `TrialPaths` missing xdg fields in host-auth mode | Made `xdg`/`xdgState`/`xdgCache` optional → Task 4 Step 1 |
| 4 | `_opts` parameter rename not mentioned | Explicitly called out → Task 4 Step 5a |
| 5 | Duplicate CLI detection in Task 3 (old) | Old Task 3 dropped; `jsonSchema` forwarded through `callLLM()` → Task 2, Task 6 |
| 6 | CLI path drops `opts.model`/`temperature`/`env` | `opts.model` forwarded via `--model`; model guard for non-Claude → Task 2 Step 4 |
| 7 | `--tools ""` with spawn unverified | Task 0 verifies; `-p` mode likely disables tools already → Task 0 Step 3, Task 1 |
| 8 | `generateWithCli` extraction understated | Extraction spelled out with line numbers → Task 3 Step 2 |
| 9 | Missing POC evidence file | Task 0 verifies all flags; evidence path corrected → Task 0 |
| 10 | `provider: 'anthropic'` semantic mismatch | Changed to `provider: 'cli'` → Task 1, Task 2 Step 1 |
| 11 | Silent model substitution for non-Claude models | Model guard in `callLLM()` throws on non-Claude without key → Task 2 Step 4 |
| 12 | `extractStructuredOutput` fragile to prefix text | Regex extraction + warning log → Task 1 Step 3 |
| 13 | `isClaudeCliAvailable` reliability / timeout | Reduced to 5s; promise-based cache → Task 1 Step 3 |
| 14 | Parallel cache race (thundering herd) | Promise-based lock on `availabilityPromise` → Task 1 Step 3 |
| 15 | `stdin.write` backpressure | Callback-based write → Task 1 Step 3 |
