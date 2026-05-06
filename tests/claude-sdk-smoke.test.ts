/**
 * Smoke test for `@anthropic-ai/claude-agent-sdk`.
 *
 * Pre-implementation check for the Claude SDK driver PRD
 * (docs/prds/2026-05-05-claude-sdk-agent-driver.md). Confirms the SDK can
 * complete one turn end-to-end against each of the two auth modes pathgrade
 * needs to support before we replace the CLI-scraping driver:
 *
 *   1. OAuth — local `claude login` keychain credentials. Run with
 *      `ANTHROPIC_*` env vars stripped so the bundled binary falls back to
 *      the keychain. Gated on the existence of `~/.claude` (best-effort) so
 *      the case is skipped on machines that have never run `claude login`.
 *
 *   2. Env vars — `APP_ANTHROPIC_BASE_URL` + `APP_ANTHROPIC_API_KEY`.
 *      vitest.config.ts already maps `APP_ANTHROPIC_*` into the test
 *      process's `ANTHROPIC_*`; we forward those through to the SDK's
 *      per-call `env` option. Gated on `APP_ANTHROPIC_API_KEY` being set.
 *
 * Each turn uses `permissionMode: 'default'` plus an auto-allow `canUseTool`
 * — the exact pairing the driver will install — so the smoke test also
 * exercises the callback path that the PRD's verification spike calls out.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import {
    query,
    type Options,
    type PermissionResult,
    type SpawnedProcess,
    type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

const TURN_TIMEOUT_MS = 60_000;

const allowAll = async (
    _toolName: string,
    input: Record<string, unknown>,
): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: input });

interface TurnOutcome {
    assistantText: string;
    success: boolean;
    /** Last `result` message, kept for diagnostic output on failure. */
    resultMessage: unknown;
}

async function runOneTurn(env: Options['env']): Promise<TurnOutcome> {
    const options: Options = {
        env,
        cwd: process.cwd(),
        permissionMode: 'default',
        canUseTool: allowAll,
    };

    let assistantText = '';
    let success = false;
    let resultMessage: unknown = null;

    for await (const msg of query({
        prompt: 'Reply with the single word: pong',
        options,
    })) {
        if (msg.type === 'assistant') {
            for (const block of msg.message.content) {
                if (block.type === 'text') {
                    assistantText += block.text;
                }
            }
        }
        if (msg.type === 'result') {
            resultMessage = msg;
            if (msg.subtype === 'success') success = true;
        }
    }

    return { assistantText, success, resultMessage };
}

/** Env with all Anthropic auth surfaces stripped so the bundled binary
 *  falls back to the local `claude login` keychain entry. */
function envWithoutAnthropicKeys(): Options['env'] {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'APP_ANTHROPIC_API_KEY',
        'APP_ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
        delete env[k];
    }
    return env;
}

/** Env that proxies `APP_ANTHROPIC_*` to the SDK as `ANTHROPIC_*`. */
function envWithAppAnthropicKeys(): Options['env'] {
    const env: Record<string, string | undefined> = { ...process.env };
    if (process.env.APP_ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = process.env.APP_ANTHROPIC_API_KEY;
    }
    if (process.env.APP_ANTHROPIC_BASE_URL) {
        env.ANTHROPIC_BASE_URL = process.env.APP_ANTHROPIC_BASE_URL;
    }
    return env;
}

/** Heuristic for whether the host has run `claude login`. We can't poke the
 *  keychain from a unit test, so we look for the marker directory the CLI
 *  writes on first login. Override with `PATHGRADE_SMOKE_OAUTH=0` to skip. */
function looksLikeOAuthIsConfigured(): boolean {
    if (process.env.PATHGRADE_SMOKE_OAUTH === '0') return false;
    if (process.env.PATHGRADE_SMOKE_OAUTH === '1') return true;
    try {
        return fs.existsSync(path.join(os.homedir(), '.claude'));
    } catch {
        return false;
    }
}

describe('Claude Agent SDK smoke test', () => {
    describe.runIf(looksLikeOAuthIsConfigured())(
        'local Claude login (OAuth)',
        () => {
            it('completes one turn using keychain credentials', async () => {
                const outcome = await runOneTurn(envWithoutAnthropicKeys());
                expect(
                    outcome.success,
                    `result message: ${JSON.stringify(outcome.resultMessage)}`,
                ).toBe(true);
                expect(outcome.assistantText.length).toBeGreaterThan(0);
            }, TURN_TIMEOUT_MS);
        },
    );

    describe.runIf(!!process.env.APP_ANTHROPIC_API_KEY)(
        'APP_ANTHROPIC_* env vars',
        () => {
            it('completes one turn using the proxied API key', async () => {
                const outcome = await runOneTurn(envWithAppAnthropicKeys());
                expect(
                    outcome.success,
                    `result message: ${JSON.stringify(outcome.resultMessage)}`,
                ).toBe(true);
                expect(outcome.assistantText.length).toBeGreaterThan(0);
            }, TURN_TIMEOUT_MS);
        },
    );

    /**
     * PRD spike (User Story #37): confirm that `permissionMode: 'default'`
     * + an auto-allowing `canUseTool` actually causes `AskUserQuestion` to
     * reach the callback. The driver design depends on this; if it ever
     * regresses to no-handshake, the new driver would silently fall back
     * to today's broken behavior.
     *
     * Strategy: prompt Claude with an instruction that forces a single
     * `AskUserQuestion` call, record every (toolName, input) the callback
     * sees, and assert at least one was `AskUserQuestion` with the
     * documented input shape (`questions[].options[].label`). The
     * callback supplies a synthesized answer so the SDK can complete
     * the turn cleanly.
     */
    const hasAnyAuth =
        looksLikeOAuthIsConfigured() || !!process.env.APP_ANTHROPIC_API_KEY;

    describe.runIf(hasAnyAuth)(
        'AskUserQuestion routes through canUseTool (PRD spike #37)',
        () => {
            it('observes the AskUserQuestion tool call with structured input', async () => {
                const observed: Array<{
                    name: string;
                    input: Record<string, unknown>;
                }> = [];

                const recorder = async (
                    toolName: string,
                    input: Record<string, unknown>,
                ): Promise<PermissionResult> => {
                    observed.push({ name: toolName, input });
                    if (toolName === 'AskUserQuestion') {
                        // Build the documented `answers` shape: question text → label.
                        const questions = (input as {
                            questions?: Array<{
                                question: string;
                                options: Array<{ label: string }>;
                            }>;
                        }).questions ?? [];
                        const answers: Record<string, string> = {};
                        for (const q of questions) {
                            const first = q.options[0]?.label ?? 'option-a';
                            answers[q.question] = first;
                        }
                        return {
                            behavior: 'allow',
                            updatedInput: { ...input, answers },
                        };
                    }
                    return { behavior: 'allow', updatedInput: input };
                };

                const env = process.env.APP_ANTHROPIC_API_KEY
                    ? envWithAppAnthropicKeys()
                    : envWithoutAnthropicKeys();

                const options: Options = {
                    env,
                    cwd: process.cwd(),
                    permissionMode: 'default',
                    canUseTool: recorder,
                };

                const prompt =
                    'You MUST call the AskUserQuestion tool exactly once. ' +
                    'Ask the user to choose between two options labeled ' +
                    '"option-a" and "option-b". Do not produce any other text ' +
                    'or call any other tool before calling AskUserQuestion.';

                let success = false;
                let resultMessage: unknown = null;
                for await (const msg of query({ prompt, options })) {
                    if (msg.type === 'result') {
                        resultMessage = msg;
                        if (msg.subtype === 'success') success = true;
                    }
                }

                const askCalls = observed.filter(
                    (c) => c.name === 'AskUserQuestion',
                );
                expect(
                    askCalls.length,
                    `observed tool calls: ${JSON.stringify(
                        observed.map((c) => c.name),
                    )} | result: ${JSON.stringify(resultMessage)}`,
                ).toBeGreaterThanOrEqual(1);

                // Confirm input matches the SDK's documented AskUserQuestion shape.
                const first = askCalls[0]!.input as {
                    questions?: Array<{
                        question?: string;
                        options?: Array<{ label?: string }>;
                    }>;
                };
                expect(Array.isArray(first.questions)).toBe(true);
                expect(first.questions!.length).toBeGreaterThanOrEqual(1);
                expect(typeof first.questions![0]!.question).toBe('string');
                expect(Array.isArray(first.questions![0]!.options)).toBe(true);
                expect(
                    first.questions![0]!.options!.length,
                ).toBeGreaterThanOrEqual(2);
                expect(
                    typeof first.questions![0]!.options![0]!.label,
                ).toBe('string');

                expect(
                    success,
                    `result message: ${JSON.stringify(resultMessage)}`,
                ).toBe(true);
            }, TURN_TIMEOUT_MS);
        },
    );

    /**
     * Pre-implementation check: confirm that pathgrade's custom
     * `spawnClaudeCodeProcess` hook is actually invoked by the SDK for the
     * bundled binary. The driver design depends on every Claude subprocess
     * passing through this hook so it can be wrapped with `sandbox-exec`. If
     * the SDK ever bypasses the hook (e.g. for a warm-pool fast path) the
     * sandbox guarantee silently regresses.
     */
    describe.runIf(hasAnyAuth)(
        'spawnClaudeCodeProcess hook is invoked',
        () => {
            it('SDK calls our custom spawn function for the bundled binary', async () => {
                let hookFired = false;
                const customSpawn = (opts: SpawnOptions): SpawnedProcess => {
                    hookFired = true;
                    return spawn(opts.command, opts.args, {
                        cwd: opts.cwd,
                        env: opts.env,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        signal: opts.signal,
                    }) as unknown as SpawnedProcess;
                };

                const env = process.env.APP_ANTHROPIC_API_KEY
                    ? envWithAppAnthropicKeys()
                    : envWithoutAnthropicKeys();

                for await (const _ of query({
                    prompt: 'Reply with the single word: ok',
                    options: {
                        env,
                        cwd: process.cwd(),
                        permissionMode: 'default',
                        canUseTool: allowAll,
                        spawnClaudeCodeProcess: customSpawn,
                    },
                })) {
                    // drain
                }

                expect(hookFired).toBe(true);
            }, TURN_TIMEOUT_MS);
        },
    );

    /**
     * Pre-implementation check: confirm that `resume: <session_id>` actually
     * restores conversation context across two `query()` calls. Multi-turn
     * fixtures (the default shape pathgrade exercises) rely on this — if
     * `resume` regresses or has an undocumented preliminary step, the new
     * driver would silently lose history between turns.
     */
    describe.runIf(hasAnyAuth)(
        'resume restores session context across turns',
        () => {
            it('turn 2 with resume:<session_id> recalls turn 1 context', async () => {
                const env = process.env.APP_ANTHROPIC_API_KEY
                    ? envWithAppAnthropicKeys()
                    : envWithoutAnthropicKeys();

                let sessionId: string | undefined;
                for await (const msg of query({
                    prompt:
                        'The secret word for this conversation is "marshmallow". ' +
                        'Reply with exactly: noted.',
                    options: {
                        env,
                        cwd: process.cwd(),
                        permissionMode: 'default',
                        canUseTool: allowAll,
                    },
                })) {
                    if (msg.type === 'system' && msg.subtype === 'init') {
                        sessionId = msg.session_id;
                    }
                }
                expect(sessionId, 'turn 1 must report a session_id').toBeTruthy();

                let turn2Text = '';
                let turn2Success = false;
                let turn2Result: unknown = null;
                for await (const msg of query({
                    prompt:
                        'What was the secret word I told you? Reply with just the word, lowercase.',
                    options: {
                        env,
                        cwd: process.cwd(),
                        permissionMode: 'default',
                        canUseTool: allowAll,
                        resume: sessionId,
                    },
                })) {
                    if (msg.type === 'assistant') {
                        for (const block of msg.message.content) {
                            if (block.type === 'text') turn2Text += block.text;
                        }
                    }
                    if (msg.type === 'result') {
                        turn2Result = msg;
                        if (msg.subtype === 'success') turn2Success = true;
                    }
                }

                expect(
                    turn2Success,
                    `turn 2 result: ${JSON.stringify(turn2Result)}`,
                ).toBe(true);
                expect(turn2Text.toLowerCase()).toContain('marshmallow');
            }, TURN_TIMEOUT_MS * 2);
        },
    );

    /**
     * Pre-implementation check: confirm that `Options.mcpServers` (the typed
     * object form) actually mounts a stdio server end-to-end. The driver
     * design replaces today's `--mcp-config <path>` CLI flag with this
     * object-form pass-through; if the SDK rejects an unrecognized field or
     * fails to launch the server, the new driver would silently lose MCP
     * support. Uses pathgrade's existing `src/mcp-mock-server.ts` so the test
     * shares a known-good wire implementation with the rest of the suite.
     */
    describe.runIf(hasAnyAuth)(
        'Options.mcpServers (object form) mounts a stdio server',
        () => {
            it('staged mock MCP server appears in the init message', async () => {
                const tmpDir = fs.mkdtempSync(
                    path.join(os.tmpdir(), 'pathgrade-smoke-mcp-'),
                );
                const fixturePath = path.join(tmpDir, 'fixture.json');
                fs.writeFileSync(
                    fixturePath,
                    JSON.stringify({
                        name: 'smoke-mcp',
                        tools: [
                            {
                                name: 'ping',
                                description: 'smoke ping',
                                response: 'pong',
                            },
                        ],
                    }),
                );
                const serverPath = path.resolve(
                    __dirname,
                    '../src/mcp-mock-server.ts',
                );

                const env = process.env.APP_ANTHROPIC_API_KEY
                    ? envWithAppAnthropicKeys()
                    : envWithoutAnthropicKeys();

                let initServers:
                    | Array<{ name: string; status: string }>
                    | undefined;
                for await (const msg of query({
                    prompt: 'Reply with: ok.',
                    options: {
                        env,
                        cwd: process.cwd(),
                        permissionMode: 'default',
                        canUseTool: allowAll,
                        mcpServers: {
                            'smoke-mcp': {
                                command: 'yarn',
                                args: ['tsx', serverPath, fixturePath],
                            },
                        },
                    },
                })) {
                    if (msg.type === 'system' && msg.subtype === 'init') {
                        initServers = msg.mcp_servers;
                    }
                }

                expect(
                    initServers,
                    'init message must report mcp_servers',
                ).toBeDefined();
                const found = initServers!.find((s) => s.name === 'smoke-mcp');
                expect(
                    found,
                    `mcp_servers: ${JSON.stringify(initServers)}`,
                ).toBeDefined();
                // Status text varies across SDK versions; accept anything not
                // explicitly reporting failure.
                expect(found!.status.toLowerCase()).not.toContain('fail');
            }, TURN_TIMEOUT_MS);
        },
    );

    /**
     * Pre-implementation check (PRD's owed verification spike): confirm that
     * with `settingSources: ['project']` a fixture-staged
     * `<cwd>/.claude/skills/<name>/SKILL.md` is auto-discovered and surfaces
     * in the init message's `skills` array, AND that the `Skill` tool name
     * appears in the init message's `tools` array. The PRD calls out that
     * `Skill` is runtime-only (not in `.d.ts`), so this is the only proof the
     * tool name pathgrade matches against actually exists. Using the init
     * message (rather than waiting for Claude to invoke the skill) makes the
     * check deterministic.
     */
    describe.runIf(hasAnyAuth)(
        'project-staged skill is discovered and Skill tool name surfaces',
        () => {
            it('init.skills contains the staged skill and init.tools contains Skill', async () => {
                const tmpDir = fs.mkdtempSync(
                    path.join(os.tmpdir(), 'pathgrade-smoke-skill-'),
                );
                const skillDir = path.join(
                    tmpDir,
                    '.claude',
                    'skills',
                    'smoke-skill',
                );
                fs.mkdirSync(skillDir, { recursive: true });
                fs.writeFileSync(
                    path.join(skillDir, 'SKILL.md'),
                    [
                        '---',
                        'name: smoke-skill',
                        'description: smoke-test skill used by the SDK smoke check',
                        '---',
                        '',
                        'When invoked, reply with the literal string: SMOKE_OK.',
                        '',
                    ].join('\n'),
                );

                const env = process.env.APP_ANTHROPIC_API_KEY
                    ? envWithAppAnthropicKeys()
                    : envWithoutAnthropicKeys();

                let initSkills: string[] | undefined;
                let initTools: string[] | undefined;
                for await (const msg of query({
                    prompt: 'Reply with: ok.',
                    options: {
                        env,
                        cwd: tmpDir,
                        permissionMode: 'default',
                        canUseTool: allowAll,
                        settingSources: ['project'],
                    },
                })) {
                    if (msg.type === 'system' && msg.subtype === 'init') {
                        initSkills = msg.skills;
                        initTools = msg.tools;
                    }
                }

                expect(
                    initSkills,
                    'init message must include a skills array',
                ).toBeDefined();
                expect(
                    initSkills!,
                    `init.skills: ${JSON.stringify(initSkills)}`,
                ).toContain('smoke-skill');

                expect(
                    initTools,
                    'init message must include a tools array',
                ).toBeDefined();
                expect(
                    initTools!,
                    `init.tools: ${JSON.stringify(initTools)}`,
                ).toContain('Skill');
            }, TURN_TIMEOUT_MS);
        },
    );
});
