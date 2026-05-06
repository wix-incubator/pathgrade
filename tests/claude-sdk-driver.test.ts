/**
 * Tests for the Claude SDK driver's orchestration shell (issue #001).
 *
 * The driver runs a Claude session through `@anthropic-ai/claude-agent-sdk`'s
 * `query()` instead of the old CLI scrape. This file exercises the
 * orchestration in isolation by injecting a fake `query` so no real Claude
 * subprocess starts:
 *
 *   - Turn 1 → no `Options.resume`; the SDK starts a new session.
 *   - Turn 2 → `Options.resume` carries the prior turn's `session_id`, so
 *     pathgrade's per-turn lifecycle and multi-turn fixtures work the same
 *     way they did under the CLI driver.
 *
 * The full SDK message projection (assistant text, tool events, typed errors,
 * cache tokens, `cost_usd`) lands in issue #002. Here we assert only what
 * the shell needs: session-id flow, per-turn options, and a non-zero shape
 * for `AgentTurnResult` so consumers don't trip on a half-built object.
 */

import { describe, expect, it } from 'vitest';
import type {
    Options,
    Query,
    SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgent } from '../src/agents/claude.js';
import type { TrialRuntime } from '../src/types.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import {
    NONINTERACTIVE_RUNTIME_POLICY,
    renderRuntimePolicy,
} from '../src/sdk/runtime-policy.js';

interface RecordedQuery {
    prompt: string | unknown;
    options: Options | undefined;
}

function makeFakeQuery(messageStreams: SDKMessage[][]): {
    query: (args: { prompt: string | unknown; options?: Options }) => Query;
    calls: RecordedQuery[];
} {
    const calls: RecordedQuery[] = [];
    let callIndex = 0;
    return {
        calls,
        query: (args) => {
            const messages = messageStreams[callIndex++] ?? [];
            calls.push({ prompt: args.prompt, options: args.options });
            // The real `Query` is an async iterable that also has control
            // methods; the shell only ever iterates it, so we satisfy the
            // iterable surface and cast — keeps the test focused.
            return (async function* () {
                for (const msg of messages) yield msg;
            })() as unknown as Query;
        },
    };
}

function makeInitMessage(sessionId: string): SDKMessage {
    return {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        agents: [],
        apiKeySource: 'none' as never,
        claude_code_version: '0.0.0-test',
        cwd: '/tmp/workspace',
        tools: [],
        mcp_servers: [],
        model: 'claude-opus-4-7',
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: 'init-uuid' as never,
    } as unknown as SDKMessage;
}

function makeAssistantMessage(text: string, sessionId: string): SDKMessage {
    return {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid: 'assistant-uuid',
        session_id: sessionId,
    } as unknown as SDKMessage;
}

function makeResultSuccess(sessionId: string, text: string): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: text,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: 'result-uuid',
        session_id: sessionId,
    } as unknown as SDKMessage;
}

describe('ClaudeAgent.createSession (SDK driver) — TB10', () => {
    it('fails fast when no askBus is supplied (live batches require a real subscriber)', async () => {
        // The SDK driver emits `lifecycle: 'live'` ask-user batches via the
        // canUseTool callback (#004). Silently resolving to `null` or an empty
        // answer map would send an empty answer back to Claude on the wire,
        // which is a worse failure mode than refusing to start. Match the
        // shared `requireAskBusForLiveBatches` contract.
        const fake = makeFakeQuery([[]]);
        const agent = new ClaudeAgent({ query: fake.query });
        await expect(
            agent.createSession('/tmp/workspace', async () => ({
                stdout: '', stderr: '', exitCode: 0,
            })),
        ).rejects.toThrow(/askBus/);
    });

    it('runs turn 1 through SDK query() with no resume option', async () => {
        const fake = makeFakeQuery([
            [
                makeInitMessage('sess-turn1'),
                makeAssistantMessage('hello', 'sess-turn1'),
                makeResultSuccess('sess-turn1', 'hello'),
            ],
        ]);

        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await session.start({ message: 'hi' });

        expect(fake.calls).toHaveLength(1);
        // Turn 1: no resume.
        expect('resume' in fake.calls[0].options!).toBe(false);
        expect(fake.calls[0].prompt).toBe('hi');
    });

    it('resumes turn 2 with the session_id reported on turn 1', async () => {
        const fake = makeFakeQuery([
            [
                makeInitMessage('sess-real-id'),
                makeResultSuccess('sess-real-id', 'turn1'),
            ],
            [
                makeInitMessage('sess-real-id'),
                makeResultSuccess('sess-real-id', 'turn2'),
            ],
        ]);

        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await session.start({ message: 'turn1' });
        await session.reply({ message: 'turn2' });

        expect(fake.calls).toHaveLength(2);
        // Turn 2: resume carries the prior turn's session_id.
        expect(fake.calls[1].options!.resume).toBe('sess-real-id');
        expect(fake.calls[1].prompt).toBe('turn2');
    });

    it('configures the per-turn Options with hermetic defaults from the builder', async () => {
        const fake = makeFakeQuery([
            [
                makeInitMessage('sess-1'),
                makeResultSuccess('sess-1', 'ok'),
            ],
        ]);

        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await session.start({ message: 'hi' });

        const opts = fake.calls[0].options!;
        expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
        expect(opts.settingSources).toEqual(['project']);
        // autoMemoryEnabled is *intentionally absent* from Options — see
        // src/agents/claude/sdk-options.ts deviation note.
        expect('autoMemoryEnabled' in opts).toBe(false);
        expect(opts.permissionMode).toBe('default');
        expect(opts.cwd).toBe('/tmp/workspace');
        expect(opts.canUseTool).toBeTypeOf('function');
        expect(opts.spawnClaudeCodeProcess).toBeTypeOf('function');
        expect(opts.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/workspace/.pathgrade-claude-config');
    });

    it('forwards ANTHROPIC_* keys from the runtime handle env onto Options.env', async () => {
        // Auth comes from `prepareWorkspace → resolveCredentials`, which writes
        // ANTHROPIC_* (keychain OAuth, host-forwarded API key, or proxy creds)
        // into `Workspace.env`. The managed session passes that env through
        // the EnvironmentHandle's `env` field; the driver must lift the
        // Anthropic keys out and place them on `Options.env` so the SDK
        // subprocess (which inherits a SAFE_HOST_VARS-filtered env) can
        // authenticate. Unrelated keys must NOT leak — the driver's contract
        // is auth, not arbitrary env pass-through.
        const fake = makeFakeQuery([
            [makeInitMessage('s'), makeResultSuccess('s', 'ok')],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const runtime: TrialRuntime = {
            handle: '/tmp/workspace',
            workspacePath: '/tmp/workspace',
            env: {
                ANTHROPIC_API_KEY: 'sk-test-123',
                ANTHROPIC_BASE_URL: 'https://proxy.example.com',
                ANTHROPIC_AUTH_TOKEN: 'oauth-token',
                UNRELATED_VAR: 'should-not-leak',
            },
        };
        const session = await agent.createSession(runtime, async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await session.start({ message: 'hi' });

        const opts = fake.calls[0].options!;
        expect(opts.env!.ANTHROPIC_API_KEY).toBe('sk-test-123');
        expect(opts.env!.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
        expect(opts.env!.ANTHROPIC_AUTH_TOKEN).toBe('oauth-token');
        // CLAUDE_CONFIG_DIR (set by the builder) survives the union — the
        // auth env merges with the per-workspace config dir, doesn't replace it.
        expect(opts.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/workspace/.pathgrade-claude-config');
        // Unrelated runtime env stays out of Options.env.
        expect('UNRELATED_VAR' in opts.env!).toBe(false);
    });

    it('forwards the model option onto the SDK query', async () => {
        const fake = makeFakeQuery([
            [makeInitMessage('s'), makeResultSuccess('s', 'ok')],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus, model: 'claude-sonnet-4-6' });

        await session.start({ message: 'hi' });

        expect(fake.calls[0].options!.model).toBe('claude-sonnet-4-6');
    });

    it('returns an AgentTurnResult with sessionId from the SDK result', async () => {
        const fake = makeFakeQuery([
            [makeInitMessage('sess-xyz'), makeResultSuccess('sess-xyz', 'pong')],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        const result = await session.start({ message: 'ping' });
        // Internal session id flows back to the orchestrator (asserted via the
        // resume behavior of the next test). The public result type does not
        // expose sessionId — full projection is #002 — but the shell must at
        // least return a structurally-valid `AgentTurnResult`.
        expect(result.exitCode).toBe(0);
        expect(Array.isArray(result.toolEvents)).toBe(true);
    });

    it('routes AskUserQuestion through the live ask-user bridge (#004)', async () => {
        // Drives a single mocked SDK turn where Claude emits an AskUserQuestion
        // tool_use, the bridge resolves it through a reaction-style ask-bus
        // subscriber, and the assistant continues the same turn with text
        // that consumed the chosen branch. The result must surface:
        //   - assistantMessage built from the typed `result` text;
        //   - one ToolEvent for AskUserQuestion whose arguments carry both
        //     the structured input AND the bridge-supplied `answers` +
        //     `answerSource: 'reaction'`.
        const askInput = {
            questions: [
                {
                    question: 'Which database should we use?',
                    header: 'Database',
                    multiSelect: false,
                    options: [
                        { label: 'SQLite', description: 'Local file' },
                        { label: 'Postgres', description: 'Server' },
                    ],
                },
            ],
        };

        // Custom fake query for this case: between the AskUserQuestion
        // tool_use message and the follow-up assistant text, the fake invokes
        // the real driver-installed `canUseTool` exactly the way the SDK
        // does — passing the same `toolUseID` that's on the tool_use block.
        // That's the real production handshake, not a side-channel call.
        let updatedInputSeenBySdk: Record<string, unknown> | undefined;
        const askToolUseId = 'toolu-ask-1';
        const fakeQuery = (args: { prompt: string | unknown; options?: Options }): Query => {
            return (async function* () {
                yield makeInitMessage('sess-ask');
                yield {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'tool_use', id: askToolUseId, name: 'AskUserQuestion', input: askInput },
                        ],
                    },
                    parent_tool_use_id: null,
                    uuid: 'a1',
                    session_id: 'sess-ask',
                } as unknown as SDKMessage;
                // SDK calls canUseTool synchronously after the tool_use block
                // is parsed; the bridge resolves through the bus and returns
                // an `allow` with the SDK's documented `answers` shape on
                // `updatedInput`. The mocked SDK accepts that and continues.
                const result = await args.options!.canUseTool!(
                    'AskUserQuestion',
                    askInput,
                    {
                        signal: new AbortController().signal,
                        suggestions: [],
                        toolUseID: askToolUseId,
                    },
                );
                if (result.behavior === 'allow') {
                    updatedInputSeenBySdk = result.updatedInput;
                }
                yield makeAssistantMessage('Going with SQLite.', 'sess-ask');
                yield makeResultSuccess('sess-ask', 'Going with SQLite.');
            })() as unknown as Query;
        };

        const agent = new ClaudeAgent({ query: fakeQuery });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        // Reaction-style subscriber — answers from the option list directly,
        // the same shape `createAskUserHandler` produces in production.
        askBus.onAsk((batch, respond) => {
            respond({
                answers: [
                    { questionId: batch.questions[0].id, values: ['SQLite'], source: 'reaction' },
                ],
            });
        });

        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        // Drive the turn — exercising the real canUseTool the driver wired up.
        const result = await session.start({ message: 'pick a db' });

        // The SDK saw the bridge-supplied answers on `updatedInput`.
        expect(updatedInputSeenBySdk).toBeDefined();
        expect((updatedInputSeenBySdk as { answers: Record<string, string> }).answers).toEqual({
            'Which database should we use?': 'SQLite',
        });

        // Assistant continued in the same turn with the chosen branch.
        expect(result.assistantMessage).toBe('Going with SQLite.');
        expect(result.exitCode).toBe(0);

        // Tool event surfaces the live ask-user round-trip with answer source.
        const askEvent = result.toolEvents.find((e) => e.providerToolName === 'AskUserQuestion');
        expect(askEvent).toBeDefined();
        expect(askEvent!.action).toBe('ask_user');
        expect(askEvent!.arguments).toMatchObject({
            answers: { 'Which database should we use?': 'SQLite' },
            answerSource: 'reaction',
        });
        expect(askEvent!.arguments?.questions).toEqual(askInput.questions);

        // Bus snapshot has the resolved batch (post-resolution snapshot view).
        const snapshot = askBus.snapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].source).toBe('claude');
        expect(snapshot[0].sourceTool).toBe('AskUserQuestion');
        expect(snapshot[0].lifecycle).toBe('live');
        expect(snapshot[0].resolution?.answers[0]).toMatchObject({
            values: ['SQLite'],
            source: 'reaction',
        });
    });

    it('throws the ask-bus rejection out of runTurn so runConversation reports completionReason error (#006)', async () => {
        // No subscriber installed — the bus' 0ms timeout fires when the
        // bridge awaits resolution. The bridge denies to the SDK with the
        // error message AND records on `lastError()`; the driver re-throws
        // after the SDK stream finishes, so the conversation runner's catch
        // sees an Error with the bus message and emits `error` completion.
        const askToolUseId = 'toolu-ask-timeout';
        const askInput = {
            questions: [
                { question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] },
            ],
        };
        const fakeQuery = (args: { prompt: string | unknown; options?: Options }): Query => {
            return (async function* () {
                yield makeInitMessage('sess-timeout');
                yield {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'tool_use', id: askToolUseId, name: 'AskUserQuestion', input: askInput },
                        ],
                    },
                    parent_tool_use_id: null,
                    uuid: 'a1',
                    session_id: 'sess-timeout',
                } as unknown as SDKMessage;
                // The SDK still calls canUseTool — the bridge denies once
                // the timeout fires. We swallow the result here because the
                // mock SDK has no real tool-call machinery; what matters is
                // the bridge captures the rejection.
                await args.options!.canUseTool!(
                    'AskUserQuestion',
                    askInput,
                    {
                        signal: new AbortController().signal,
                        suggestions: [],
                        toolUseID: askToolUseId,
                    },
                );
                yield makeResultSuccess('sess-timeout', 'streamed-result-text');
            })() as unknown as Query;
        };

        const agent = new ClaudeAgent({ query: fakeQuery });
        const askBus = createAskBus({ askUserTimeoutMs: 0 });
        // No subscriber — the live batch will time out.
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await expect(session.start({ message: 'go' })).rejects.toThrow(/did not resolve within 0ms/);
    });

    it('does NOT prepend the non-interactive runtime-policy text to the SDK prompt even when sessionOptions carries it (#007)', async () => {
        // Pre-#004, the legacy Claude CLI driver prepended the
        // `noninteractive-user-question` policy text in front of the
        // user's message on first turn to wallpaper the missing live
        // ask-user transport. Post-#004 the policy infrastructure is
        // intentionally never consulted on the Claude path — capability
        // flipped to `'reliable'`, planRuntimePolicies('claude') === [].
        // #007 locks this in: even if a caller hands the SDK driver an
        // AgentSessionOptions with `runtimePolicies` populated, the SDK
        // `query()` must see the bare user message, not a prepend.
        const fake = makeFakeQuery([
            [
                makeInitMessage('sess-policy'),
                makeResultSuccess('sess-policy', 'ok'),
            ],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus, runtimePolicies: [NONINTERACTIVE_RUNTIME_POLICY] });

        await session.start({ message: 'do the thing' });

        // Bare prompt — no policy text injected.
        expect(fake.calls[0].prompt).toBe('do the thing');
        // Defensive: the rendered policy text must not appear anywhere in
        // the prompt the SDK saw.
        const renderedPolicy = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'claude' });
        expect(String(fake.calls[0].prompt)).not.toContain(renderedPolicy);
    });

    it('returns runtimePoliciesApplied as an empty array even when sessionOptions carries policies (#007)', async () => {
        // Mirrors the projector-level invariant exercised by
        // tests/claude-sdk-projector.test.ts but at the driver shell so a
        // future refactor that re-introduces a policy-application path
        // (e.g. through claude.ts reading sessionOptions.runtimePolicies)
        // breaks this test before it ships.
        const fake = makeFakeQuery([
            [
                makeInitMessage('sess-empty-applied'),
                makeResultSuccess('sess-empty-applied', 'ok'),
            ],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus, runtimePolicies: [NONINTERACTIVE_RUNTIME_POLICY] });

        const result = await session.start({ message: 'hi' });

        expect(result.runtimePoliciesApplied).toEqual([]);
    });
});
