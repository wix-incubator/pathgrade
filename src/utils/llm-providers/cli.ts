import { spawn } from 'child_process';
import type { LLMProvider, LLMCallOptions, LLMCallResult } from '../llm-types.js';

// --- Availability check with promise-based dedup ---

const availabilityPromises = new Map<string, Promise<boolean>>();

function getCliAvailability(command: string, args: string[], timeoutSec: number): Promise<boolean> {
    const cacheKey = `${command} ${args.join(' ')}`;
    const existing = availabilityPromises.get(cacheKey);
    if (existing) return existing;

    const promise = checkCliAvailability(command, args, timeoutSec);
    availabilityPromises.set(cacheKey, promise);
    return promise;
}

async function checkCliAvailability(command: string, args: string[], timeoutSec: number): Promise<boolean> {
    try {
        const result = await runCli(command, args, {}, timeoutSec);
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

/** Reset the availability cache (for testing). */
export function resetCliCache(): void {
    availabilityPromises.clear();
}

/** Check if claude CLI is installed and authenticated. */
export async function isClaudeCliAvailable(): Promise<boolean> {
    return getCliAvailability('claude', ['auth', 'status'], 5);
}

export async function isCodexCliAvailable(): Promise<boolean> {
    return getCliAvailability('codex', ['login', 'status'], 5);
}

// --- JSON envelope parsing ---

interface CliEnvelope {
    result?: string;
    structured_output?: unknown;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

export function parseCliEnvelope(raw: string): CliEnvelope {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    try {
        return JSON.parse(jsonMatch[0]);
    } catch {
        return {};
    }
}

export function extractStructuredOutput(raw: string): string {
    const envelope = parseCliEnvelope(raw);
    if (!envelope || (!envelope.structured_output && !envelope.result)) {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        return jsonMatch ? jsonMatch[0] : raw.trim();
    }
    if (envelope.structured_output && typeof envelope.structured_output === 'object') {
        return JSON.stringify(envelope.structured_output);
    }
    if (typeof envelope.result === 'string' && envelope.result) {
        return envelope.result;
    }
    return raw.trim();
}

// --- CLI adapter ---

export const cliProvider: LLMProvider = {
    name: 'cli',

    async isAvailable(): Promise<boolean> {
        return isClaudeCliAvailable();
    },

    supportsModel(model: string): boolean {
        const normalized = model.trim().toLowerCase();
        // CLI supports Claude models and unknown models (defaults to claude-cli)
        if (normalized.startsWith('claude')) return true;
        // CLI does NOT support non-Claude models like gpt-*, o1, o3, o4
        if (
            normalized.startsWith('gpt-')
            || normalized.startsWith('chatgpt-')
            || normalized.startsWith('o1')
            || normalized.startsWith('o3')
            || normalized.startsWith('o4')
        ) {
            return false;
        }
        // Unknown models — let CLI try (it will fail gracefully)
        return true;
    },

    async call(prompt: string, opts: LLMCallOptions): Promise<LLMCallResult> {
        const args = ['-p', '--no-session-persistence'];

        if (opts.model) {
            args.push('--model', opts.model);
        }

        // Always use JSON output to get token usage from the envelope
        args.push('--output-format', 'json');

        if (opts.jsonSchema) {
            args.push('--json-schema', opts.jsonSchema);
        }

        const result = await runCli('claude', args, opts.env ?? {}, 120, prompt);

        if (result.exitCode !== 0) {
            throw new Error(
                `Claude CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 300)}`
            );
        }

        const envelope = parseCliEnvelope(result.stdout);

        let text: string;
        if (opts.jsonSchema) {
            // For structured output, extract structured_output or result
            if (envelope.structured_output && typeof envelope.structured_output === 'object') {
                text = JSON.stringify(envelope.structured_output);
            } else if (typeof envelope.result === 'string' && envelope.result) {
                text = envelope.result;
            } else {
                text = extractStructuredOutput(result.stdout);
            }
        } else {
            // For plain text, extract result from the JSON envelope
            text = typeof envelope.result === 'string' ? envelope.result : result.stdout.trim();
        }

        const usage = envelope.usage;
        const inputTokens = usage
            ? (usage.input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0)
                + (usage.cache_read_input_tokens ?? 0)
            : undefined;

        return {
            text,
            inputTokens: inputTokens || undefined,
            outputTokens: usage?.output_tokens,
            provider: 'cli',
            model: opts.model || 'claude-cli',
        };
    },
};

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
