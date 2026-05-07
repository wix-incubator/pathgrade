/**
 * End-to-end integration test for the Claude SDK driver migration.
 *
 * The slice-level tests cover each module in isolation
 * (`tests/sandboxed-claude-spawn.test.ts`, `tests/claude-sdk-options.test.ts`,
 * `tests/claude-ask-user-bridge.test.ts`, `tests/claude-sdk-projector.test.ts`,
 * `tests/claude-sdk-driver.test.ts`). This file is the single composition
 * test: it drives the `ClaudeAgent` shell — with a mocked SDK `query()` — all
 * the way through the production `runConversation` runner so the four deep
 * modules (sdk-options builder, ask-user bridge, sdk-message projector,
 * sandboxed spawn) plus the agent-result log writer all collaborate over a
 * full multi-turn flow.
 *
 * Real components exercised:
 *   - `ClaudeAgent.createSession` (with a fake `query` from the SDK seam)
 *   - The live `canUseTool` ask-user bridge over a real `AskBus`
 *   - The SDK-message projector totalizing tokens, cache breakdowns, and
 *     `costUsd` from the typed result message
 *   - The conversation runner's reaction loop (`createAskUserHandler` →
 *     `tryReactionsForQuestion` → bridge response)
 *   - The agent-result log writer (`buildModelAgentResultLogEntry`) emitting
 *     `cost_usd` per turn
 *   - The bus's resolved-batch snapshot exposed via `runConversation` deps
 *
 * Mocked seams (kept narrow):
 *   - The SDK's `query()` is replaced with a fake async-iterable that
 *     scripts the typed message stream per turn. This is the same seam the
 *     driver-level tests use.
 *   - The driver's spawn module never runs because the fake `query` does
 *     not call it; production `Options.spawnClaudeCodeProcess` is wired up
 *     but the fake bypasses subprocess creation.
 *
 * The two-turn flow:
 *   Turn 1 — assistant asks `AskUserQuestion` ("Which database should we use?",
 *            options: SQLite / Postgres). Reaction fires with `Postgres`.
 *            Assistant continues the same turn with branching text that names
 *            the chosen database. Result message reports tokens + cost.
 *   Turn 2 — user replies. Assistant emits a follow-up message that names
 *            Postgres specifically (proves the branch decision flowed across
 *            turns via the SDK's resume semantics). Result message reports
 *            additional tokens + cost on a fresh `session_id`.
 */

import { describe, expect, it } from 'vitest';
import type {
    Options,
    Query,
    SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentTurnResult, LogEntry } from '../src/types.js';
import { ClaudeAgent } from '../src/agents/claude.js';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { Message } from '../src/sdk/types.js';

interface RecordedQuery {
    prompt: string | unknown;
    options: Options | undefined;
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
        tools: ['AskUserQuestion'],
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

function makeAssistantMessage(text: string, sessionId: string, uuid: string): SDKMessage {
    return {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid,
        session_id: sessionId,
    } as unknown as SDKMessage;
}

function makeResultSuccess(
    sessionId: string,
    text: string,
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    },
    totalCostUsd: number,
    uuid: string,
): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: text,
        stop_reason: 'end_turn',
        total_cost_usd: totalCostUsd,
        usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            ...usage,
        },
        modelUsage: {},
        permission_denials: [],
        uuid,
        session_id: sessionId,
    } as unknown as SDKMessage;
}

describe('Claude SDK driver — end-to-end mocked composition', () => {
    it('drives an ask-user round trip across two turns through runConversation', async () => {
        // ── Scripted SDK stream. The fake `query()` is passed the same
        //    `canUseTool` the driver wires up for production, so the bridge
        //    is exercised through the real call shape — not stubbed.
        const askToolUseId = 'toolu-db-pick';
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

        const calls: RecordedQuery[] = [];
        let updatedInputSeenBySdk: Record<string, unknown> | undefined;

        const fakeQuery = (args: { prompt: string | unknown; options?: Options }): Query => {
            calls.push({ prompt: args.prompt, options: args.options });
            const callIdx = calls.length;

            return (async function* (): AsyncGenerator<SDKMessage> {
                if (callIdx === 1) {
                    // Turn 1: init → AskUserQuestion tool_use → (canUseTool
                    // resolves through bus → reaction supplies "Postgres") →
                    // assistant text consuming the branch → result.
                    yield makeInitMessage('sess-turn1');
                    yield {
                        type: 'assistant',
                        message: {
                            content: [
                                {
                                    type: 'tool_use',
                                    id: askToolUseId,
                                    name: 'AskUserQuestion',
                                    input: askInput,
                                },
                            ],
                        },
                        parent_tool_use_id: null,
                        uuid: 'a1-toolu',
                        session_id: 'sess-turn1',
                    } as unknown as SDKMessage;
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
                    yield makeAssistantMessage(
                        'Going with Postgres; setting up the connection.',
                        'sess-turn1',
                        'a1-text',
                    );
                    yield makeResultSuccess(
                        'sess-turn1',
                        'Going with Postgres; setting up the connection.',
                        { input_tokens: 12, output_tokens: 7, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 },
                        0.0125,
                        'r1',
                    );
                    return;
                }

                // Turn 2: a plain follow-up that confirms branch state
                // crossed turns. `Options.resume` carries `sess-turn1`.
                yield makeInitMessage('sess-turn2');
                yield makeAssistantMessage(
                    'Postgres is configured. Schema migration is next.',
                    'sess-turn2',
                    'a2-text',
                );
                yield makeResultSuccess(
                    'sess-turn2',
                    'Postgres is configured. Schema migration is next.',
                    { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 2 },
                    0.0008,
                    'r2',
                );
            })() as unknown as Query;
        };

        // ── Real ClaudeAgent + real bus + real session.
        const agent = new ClaudeAgent({ query: fakeQuery });
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });

        // Track cost and tokens so the test asserts both the per-turn log
        // entries AND the runtime accumulator behavior the production
        // `runConversation` agent wrapper depends on.
        let costAccum = 0;
        let tokenInputAccum = 0;
        let tokenOutputAccum = 0;

        const session = await agent.createSession(
            '/tmp/workspace',
            async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            { askBus },
        );

        // ── Drive the runner against the real driver. `sendTurn` tracks the
        //    AgentTurnResult so we can assert on it; `runConversation` also
        //    pushes `agent_result` log entries (which is where `cost_usd`
        //    surfaces per the agent-result log writer).
        const log: LogEntry[] = [];
        const messages: Message[] = [];
        const turnResults: AgentTurnResult[] = [];
        let turnCounter = 0;

        const sendTurn = async (msg: string): Promise<AgentTurnResult> => {
            turnCounter += 1;
            const turn = turnCounter === 1
                ? await session.start({ message: msg })
                : await session.reply!({ message: msg });
            turnResults.push(turn);
            // Mirror the production `AgentImpl.sendTurn` accumulator (the
            // runner does not do this; the agent wrapper does). The point
            // of doing it here is to lock that the projector populates
            // `inputTokens` / `outputTokens` / `costUsd` on the
            // AgentTurnResult shape consumers actually accumulate from.
            tokenInputAccum += turn.inputTokens ?? 0;
            tokenOutputAccum += turn.outputTokens ?? 0;
            if (turn.costUsd !== undefined) costAccum += turn.costUsd;
            return turn;
        };

        const deps: ConversationDeps = {
            sendTurn,
            hasFile: async () => false,
            workspace: '/tmp/workspace',
            messages,
            log,
            askBus,
            agentName: 'claude',
        };

        const result = await runConversation(
            {
                firstMessage: 'pick a db and start',
                maxTurns: 4,
                reactions: [
                    // ask-user reaction supplies the chosen branch in real time
                    {
                        whenAsked: (q) =>
                            !!q.options && q.options.some((o) => o.label === 'Postgres'),
                        answer: 'Postgres',
                    },
                    // text reaction drives turn 2 — runner sends this user reply
                    // when turn 1's assistant message matches.
                    {
                        when: /Going with Postgres/,
                        reply: 'great — show me the migration plan',
                    },
                ],
                until: ({ lastMessage }) => /migration is next/i.test(lastMessage),
            },
            deps,
        );

        // ── Two turns ran end-to-end through the real driver shell.
        expect(result.turns).toBe(2);
        expect(result.completionReason).toBe('until');
        expect(turnResults).toHaveLength(2);
        expect(calls).toHaveLength(2);

        // ── Per-turn SDK options reflect resume-on-turn-2 (multi-turn semantics).
        expect('resume' in calls[0].options!).toBe(false);
        expect(calls[1].options!.resume).toBe('sess-turn1');

        // ── Bridge fed the SDK its `answers` map on `updatedInput` (the
        //    same handshake the SDK does in production).
        expect(updatedInputSeenBySdk).toBeDefined();
        expect((updatedInputSeenBySdk as { answers: Record<string, string> }).answers).toEqual({
            'Which database should we use?': 'Postgres',
        });

        // ── ask_user tool-event shape on turn 1: full input plus
        //    bridge-merged `answers` + `answerSource: 'reaction'`.
        const turn1Events = turnResults[0].toolEvents;
        const askEvent = turn1Events.find((e) => e.providerToolName === 'AskUserQuestion');
        expect(askEvent).toBeDefined();
        expect(askEvent!.action).toBe('ask_user');
        expect(askEvent!.arguments).toMatchObject({
            answers: { 'Which database should we use?': 'Postgres' },
            answerSource: 'reaction',
        });
        expect(askEvent!.arguments?.questions).toEqual(askInput.questions);

        // ── Visible assistant messages on each turn — the projector built
        //    them from typed `result.result` text, not NDJSON parsing.
        expect(turnResults[0].assistantMessage).toBe('Going with Postgres; setting up the connection.');
        expect(turnResults[0].visibleAssistantMessage).toBe('Going with Postgres; setting up the connection.');
        expect(turnResults[0].visibleAssistantMessageSource).toBe('assistant_message');
        expect(turnResults[1].assistantMessage).toBe('Postgres is configured. Schema migration is next.');

        // ── Per-turn token usage carried on AgentTurnResult, totalized per
        //    pathgrade convention (uncached + cache_creation + cache_read).
        expect(turnResults[0].inputTokens).toBe(12 + 5 + 3);
        expect(turnResults[0].outputTokens).toBe(7);
        expect(turnResults[0].cacheCreationInputTokens).toBe(5);
        expect(turnResults[0].cacheReadInputTokens).toBe(3);
        expect(turnResults[1].inputTokens).toBe(4 + 0 + 2);
        expect(turnResults[1].outputTokens).toBe(9);
        expect(turnResults[1].cacheReadInputTokens).toBe(2);

        // The accumulator (which AgentImpl.sendTurn drives in production)
        // sees the totals across both turns.
        expect(tokenInputAccum).toBe(12 + 5 + 3 + 4 + 0 + 2);
        expect(tokenOutputAccum).toBe(7 + 9);

        // ── Per-turn costUsd surfaced on AgentTurnResult AND accumulated.
        expect(turnResults[0].costUsd).toBeCloseTo(0.0125, 10);
        expect(turnResults[1].costUsd).toBeCloseTo(0.0008, 10);
        expect(costAccum).toBeCloseTo(0.0133, 10);

        // ── `cost_usd` written into the `agent_result` log entries the
        //    runner pushes per turn (via `buildModelAgentResultLogEntry`).
        const agentResultEntries = log.filter((e) => e.type === 'agent_result');
        expect(agentResultEntries).toHaveLength(2);
        expect(agentResultEntries[0].cost_usd).toBeCloseTo(0.0125, 10);
        expect(agentResultEntries[1].cost_usd).toBeCloseTo(0.0008, 10);

        // ── Resolved bus snapshot view: the live ask-user batch from turn 1
        //    is recorded with its resolution (reaction-source answer).
        const snapshot = askBus.snapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].source).toBe('claude');
        expect(snapshot[0].sourceTool).toBe('AskUserQuestion');
        expect(snapshot[0].lifecycle).toBe('live');
        expect(snapshot[0].turnNumber).toBe(1);
        expect(snapshot[0].toolUseId).toBe(askToolUseId);
        expect(snapshot[0].resolution).not.toBeNull();
        expect(snapshot[0].resolution!.answers[0]).toMatchObject({
            values: ['Postgres'],
            source: 'reaction',
        });

        // ── `ask_batch` log entry dual-written alongside the agent_result
        //    on turn 1, before that turn's agent_result entry.
        const askBatchEntries = log.filter((e) => e.type === 'ask_batch');
        expect(askBatchEntries).toHaveLength(1);
        expect(askBatchEntries[0]).toMatchObject({
            type: 'ask_batch',
            turn_number: 1,
            source: 'claude',
            source_tool: 'AskUserQuestion',
            lifecycle: 'live',
            resolved: true,
        });

        // ── Reactions-fired ledger: the text reaction that drove turn 2
        //    is tracked. (The runner's `reactionsFired` ledger is text-only;
        //    the ask-user reaction's effect is captured on the bus
        //    snapshot's resolution.answers[…].source above.)
        expect(result.reactionsFired).toBeDefined();
        expect(result.reactionsFired!.length).toBeGreaterThanOrEqual(1);
        expect(result.reactionsFired!.some((e) => e.reactionIndex === 1)).toBe(true);
    });
});
