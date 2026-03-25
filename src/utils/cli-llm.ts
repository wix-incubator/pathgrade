import { spawn } from 'child_process';

// Define own return type to avoid circular dependency with llm.ts
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
 * Uses a promise-based lock so concurrent callers share one check.
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
    if (availabilityPromise !== null) return availabilityPromise;
    availabilityPromise = checkCliAvailability();
    return availabilityPromise;
}

async function checkCliAvailability(): Promise<boolean> {
    try {
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
 * Uses regex extraction as a safety net in case stdout contains debug
 * lines before the JSON envelope.
 */
export function extractStructuredOutput(raw: string): string {
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
