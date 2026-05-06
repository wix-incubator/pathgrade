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
import { createAskBus } from '../src/sdk/ask-bus/bus.js';

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
        expect(Array.isArray(result.blockedPrompts)).toBe(true);
    });

    it('routes AskUserQuestion through the placeholder deny while #004 is unimplemented', async () => {
        // Capture the canUseTool the driver installed and exercise it directly;
        // this guards the interim-state contract noted on issue #001.
        const fake = makeFakeQuery([
            [makeInitMessage('s'), makeResultSuccess('s', 'ok')],
        ]);
        const agent = new ClaudeAgent({ query: fake.query });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const session = await agent.createSession('/tmp/workspace', async () => ({
            stdout: '', stderr: '', exitCode: 0,
        }), { askBus });

        await session.start({ message: 'hi' });

        const canUseTool = fake.calls[0].options!.canUseTool!;
        const askResult = await canUseTool('AskUserQuestion', { questions: [] }, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: 'test',
        });
        expect(askResult.behavior).toBe('deny');
        if (askResult.behavior === 'deny') {
            expect(askResult.message).toMatch(/#004/);
        }

        const bashResult = await canUseTool('Bash', { command: 'ls' }, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: 'test',
        });
        expect(bashResult.behavior).toBe('allow');
    });
});
