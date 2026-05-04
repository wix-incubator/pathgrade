import { describe, it, expect, vi } from 'vitest';
import { previewReactions, runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import type { AgentTurnResult } from '../src/types.js';
import type { Message } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';

function scriptedAgent(responses: string[]) {
    let i = 0;
    const sent: string[] = [];
    return {
        sendTurn: async (message: string) => {
            sent.push(message);
            if (i >= responses.length) throw new Error('No more scripted responses');
            return responses[i++];
        },
        sent,
    };
}

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
    return {
        sendTurn: async () => 'default response',
        hasFile: async () => false,
        workspace: '/tmp/test',
        messages: [] as Message[],
        log: [] as LogEntry[],
        ...overrides,
    };
}

describe('conversation runner', () => {
    it('1: reactions match in order, first wins', async () => {
        const agent = scriptedAgent(['Please confirm your choice.', 'Thanks!']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [
                    { when: /confirm/, reply: 'First match' },
                    { when: /confirm|choice/, reply: 'Second match' },
                ],
                maxTurns: 2,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        // After opener, agent says "confirm" → first reaction wins
        expect(agent.sent[1]).toBe('First match');
        expect(result.turns).toBe(2);
    });

    it('2: once-reactions fire only once', async () => {
        const agent = scriptedAgent([
            'confirm this',    // turn 1 → once-reaction fires
            'confirm again',   // turn 2 → once-reaction skipped, catch-all matches
            'done',            // turn 3
        ]);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [
                    { when: /confirm/, reply: 'Yes confirmed', once: true },
                    { when: /.*/, reply: 'Continue' },
                ],
                maxTurns: 3,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(agent.sent[1]).toBe('Yes confirmed');  // once-reaction fires
        expect(agent.sent[2]).toBe('Continue');        // once-reaction skipped, catch-all wins
        expect(result.turns).toBe(3);
    });

    it('2b: unless veto prevents a matching reaction from firing', async () => {
        const agent = scriptedAgent(['artifact available', 'done']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [
                    { when: /artifact available/, unless: /artifact available/, reply: 'Should not fire' },
                    { when: /.*/, reply: 'Fallback reply' },
                ],
                maxTurns: 2,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(agent.sent[1]).toBe('Fallback reply');
        expect(result.turns).toBe(2);
    });

    it('2c: unless veto does not consume once reactions', async () => {
        const agent = scriptedAgent([
            'artifact available',      // vetoed
            'artifact available now',  // fires here
            'done',
        ]);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [
                    { when: /artifact available/, unless: /^artifact available$/, reply: 'Confirmed', once: true },
                    { when: /.*/, reply: 'Continue' },
                ],
                maxTurns: 3,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(agent.sent[1]).toBe('Continue');
        expect(agent.sent[2]).toBe('Confirmed');
        expect(result.turns).toBe(3);
    });

    it('3: until predicate ends conversation (completionReason: until)', async () => {
        const agent = scriptedAgent(['response 1', 'response 2']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                until: ({ turn }) => turn >= 2,
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.completionReason).toBe('until');
        expect(result.turns).toBe(2);
    });

    it('4: maxTurns ends conversation (completionReason: maxTurns)', async () => {
        const agent = scriptedAgent(['r1', 'r2', 'r3']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
                maxTurns: 3,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.completionReason).toBe('maxTurns');
        expect(result.turns).toBe(3);
    });

    it('5: no matching reaction + no persona ends conversation (completionReason: noReply)', async () => {
        const agent = scriptedAgent(['something unexpected']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /xyz_never_matches/, reply: 'Nope' }],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.completionReason).toBe('noReply');
        expect(result.turns).toBe(1);
    });

    it('6: persona fallback when no reaction matches', async () => {
        const agent = scriptedAgent(['something unexpected', 'great']);
        const personaReply = vi.fn().mockResolvedValue('Persona says hello');

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /xyz_never_matches/, reply: 'Nope' }],
                maxTurns: 2,
            },
            makeDeps({ sendTurn: agent.sendTurn, personaReply }),
        );

        expect(personaReply).toHaveBeenCalledOnce();
        expect(agent.sent[1]).toBe('Persona says hello');
        expect(result.turns).toBe(2);
    });

    it('7: step scorers run after specified turn', async () => {
        const agent = scriptedAgent(['r1', 'r2', 'r3']);
        const mockGradeResult = { score: 0.8, scorers: [] };
        const runStepScorers = vi.fn().mockResolvedValue(mockGradeResult);
        const scorers = [{ type: 'check' as const, name: 'test', weight: 1, fn: () => true }];

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
                maxTurns: 3,
                stepScorers: [{ afterTurn: 2, scorers }],
            },
            makeDeps({ sendTurn: agent.sendTurn, runStepScorers }),
        );

        expect(runStepScorers).toHaveBeenCalledOnce();
        expect(runStepScorers).toHaveBeenCalledWith(scorers);
        expect(result.stepResults).toEqual([{ afterTurn: 2, result: mockGradeResult }]);
    });

    it('8: default maxTurns is 30', async () => {
        let callCount = 0;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({
                sendTurn: async () => {
                    callCount++;
                    return 'response';
                },
            }),
        );

        expect(result.turns).toBe(30);
        expect(result.completionReason).toBe('maxTurns');
    });

    it('9: UntilContext receives correct messages array', async () => {
        const agent = scriptedAgent(['agent reply 1', 'agent reply 2']);
        const capturedMessages: Message[][] = [];

        const result = await runConversation(
            {
                firstMessage: 'Hello',
                until: ({ messages }) => {
                    capturedMessages.push([...messages]);
                    return messages.length >= 4; // 2 user + 2 agent
                },
                reactions: [{ when: /.*/, reply: 'User reply' }],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        // First until check: after turn 1 (opener + agent response)
        expect(capturedMessages[0]).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'agent', content: 'agent reply 1' },
        ]);
        // Second until check: after turn 2
        expect(capturedMessages[1]).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'agent', content: 'agent reply 1' },
            { role: 'user', content: 'User reply' },
            { role: 'agent', content: 'agent reply 2' },
        ]);
        expect(result.completionReason).toBe('until');
    });

    it('10: agent timeout returns completionReason: timeout', async () => {
        let callCount = 0;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({
                sendTurn: async () => {
                    callCount++;
                    if (callCount === 2) throw new Error('Agent timed out');
                    return 'response';
                },
            }),
        );

        expect(result.completionReason).toBe('timeout');
        expect(result.turns).toBe(1);
        expect(result.turnTimings).toHaveLength(1);
    });

    it('11: non-timeout agent error returns completionReason: error', { timeout: 15_000 }, async () => {
        let callCount = 0;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({
                sendTurn: async () => {
                    callCount++;
                    if (callCount >= 2) throw new Error('Agent exited with code 1');
                    return 'response';
                },
            }),
        );

        expect(result.completionReason).toBe('error');
        expect(result.completionDetail).toContain('Agent exited with code 1');
        expect(result.turns).toBe(1);
    });

    it('12: retries transient error then succeeds', async () => {
        let callCount = 0;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({
                sendTurn: async () => {
                    callCount++;
                    // Fail on first call of turn 2, succeed on retry
                    if (callCount === 2) throw new Error('Agent exited with code 1');
                    return 'response';
                },
            }),
        );

        expect(result.turns).toBe(2);
        expect(result.completionReason).toBe('maxTurns');
    });

    it('13: turnTimings records duration per turn', async () => {
        const agent = scriptedAgent(['r1', 'r2']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.turnTimings).toHaveLength(2);
        expect(result.turnTimings[0].turn).toBe(1);
        expect(result.turnTimings[1].turn).toBe(2);
        expect(result.turnTimings[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(result.turnTimings[1].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('14: timeout includes completionDetail with error message', async () => {
        let callCount = 0;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({
                sendTurn: async () => {
                    callCount++;
                    if (callCount === 2) throw new Error('Agent timed out after 300s');
                    return 'response';
                },
            }),
        );

        expect(result.completionReason).toBe('timeout');
        expect(result.completionDetail).toContain('timed out');
    });

    it('15: conversation_end log entry emitted with timing', async () => {
        const agent = scriptedAgent(['r1', 'r2']);
        const log: import('../src/types.js').LogEntry[] = [];

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({ sendTurn: agent.sendTurn, log }),
        );

        const endEntry = log.find((e) => e.type === 'conversation_end');
        expect(endEntry).toBeDefined();
        expect(endEntry!.completion_reason).toBe('maxTurns');
        expect(endEntry!.turn_number).toBe(2);
        expect(endEntry!.turn_timings).toHaveLength(2);
    });

    it('16: turnDetails captures output line and character counts', async () => {
        const agent = scriptedAgent(['first line\nsecond line', 'short']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /.*/, reply: 'Continue' }],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.turnDetails).toHaveLength(2);
        expect(result.turnDetails![0]).toMatchObject({
            turn: 1,
            outputLines: 2,
            outputChars: 'first line\nsecond line'.length,
        });
        expect(result.turnDetails![1]).toMatchObject({
            turn: 2,
            outputLines: 1,
            outputChars: 'short'.length,
        });
    });

    it('17: reactionsFired records matched reaction metadata', async () => {
        const agent = scriptedAgent(['please confirm', 'done']);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [
                    { when: /never/, reply: 'skip me' },
                    { when: /confirm/, reply: 'Confirmed' },
                ],
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(result.reactionsFired).toEqual([
            {
                turn: 1,
                reactionIndex: 1,
                pattern: '/confirm/',
                reply: 'Confirmed',
            },
        ]);
    });

    it('18: conversation_end log entry carries diagnostics payloads', async () => {
        const agent = scriptedAgent(['confirm now', 'done']);
        const log: import('../src/types.js').LogEntry[] = [];

        await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /confirm/, reply: 'Confirmed' }],
            },
            makeDeps({ sendTurn: agent.sendTurn, log }),
        );

        const endEntry = log.find((e) => e.type === 'conversation_end');
        expect(endEntry?.turn_details).toHaveLength(2);
        expect(endEntry?.reactions_fired).toEqual([
            {
                turn: 1,
                reactionIndex: 0,
                pattern: '/confirm/',
                reply: 'Confirmed',
            },
        ]);
    });

    it('19: unless vetoes a matching reaction without consuming once', async () => {
        const agent = scriptedAgent([
            'confirm later',
            'confirm now',
            'done',
        ]);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                reactions: [
                    { when: /confirm/i, unless: /later/i, reply: 'Confirmed', once: true },
                    { when: /.*/, reply: 'Fallback' },
                ],
                maxTurns: 3,
            },
            makeDeps({ sendTurn: agent.sendTurn }),
        );

        expect(agent.sent[1]).toBe('Fallback');
        expect(agent.sent[2]).toBe('Confirmed');
        expect(result.turns).toBe(3);
    });

    it('20: previewReactions reports fired, vetoed, and no-match states per agent turn', async () => {
        const preview = previewReactions(
            [
                { role: 'user', content: 'Start' },
                { role: 'agent', content: 'confirm later' },
                { role: 'user', content: 'continue' },
                { role: 'agent', content: 'confirm now' },
            ],
            [
                { when: /confirm/i, unless: /later/i, reply: 'Confirmed', once: true },
                { when: /done/i, reply: 'Done' },
            ],
        );

        expect(preview.turns).toHaveLength(2);
        expect(preview.turns[0]).toMatchObject({
            turn: 1,
            agentMessage: 'confirm later',
            reactions: [
                {
                    reactionIndex: 0,
                    whenMatched: true,
                    unlessMatched: true,
                    fired: false,
                    status: 'vetoed',
                },
                {
                    reactionIndex: 1,
                    whenMatched: false,
                    unlessMatched: false,
                    fired: false,
                    status: 'no-match',
                },
            ],
        });
        expect(preview.turns[1].reactions[0]).toMatchObject({
            reactionIndex: 0,
            whenMatched: true,
            unlessMatched: false,
            fired: true,
            status: 'fired',
            reply: 'Confirmed',
        });
    });

    it('21: replays blocked prompt queues in order before rerunning the model', async () => {
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'I know the next steps already.',
                assistantMessage: 'I know the next steps already.',
                visibleAssistantMessage: '**Approval**\nShould I proceed?\n- **Yes** - Continue\n- **No** - Stop',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'Should I proceed?',
                        header: 'Approval',
                        options: [
                            { label: 'Yes', description: 'Continue' },
                            { label: 'No', description: 'Stop' },
                        ],
                        sourceTool: 'AskUserQuestion',
                        order: 0,
                    },
                    {
                        prompt: 'Which environment should I use?',
                        header: 'Target environment',
                        options: [
                            { label: 'Prod', description: 'Use production' },
                            { label: 'Staging', description: 'Use staging' },
                        ],
                        sourceTool: 'AskUserQuestion',
                        order: 1,
                    },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'All set.',
                assistantMessage: 'All set.',
                visibleAssistantMessage: 'All set.',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);
        const until = vi.fn().mockResolvedValue(true);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until,
                reactions: [
                    { when: /Should I proceed\?/, reply: 'Yes' },
                    { when: /Which environment should I use\?/, reply: 'Prod' },
                ],
            },
            makeDeps({ sendTurn }),
        );

        expect(sendTurn).toHaveBeenCalledTimes(2);
        expect(sendTurn.mock.calls.map(([message]) => message)).toEqual(['Start', 'Prod']);
        expect(result.turns).toBe(2);
        expect(result.completionReason).toBe('until');
    });

    it('22: defers maxTurns until the blocked prompt queue is exhausted', async () => {
        const sendTurn = vi.fn().mockResolvedValue({
            rawOutput: 'Summary that should stay hidden.',
            assistantMessage: 'Summary that should stay hidden.',
            visibleAssistantMessage: 'First blocked prompt',
            visibleAssistantMessageSource: 'blocked_prompt',
            blockedPrompts: [
                {
                    prompt: 'First blocked prompt',
                    options: [],
                    sourceTool: 'AskUserQuestion',
                    order: 0,
                },
                {
                    prompt: 'Second blocked prompt',
                    options: [],
                    sourceTool: 'AskUserQuestion',
                    order: 1,
                },
            ],
            exitCode: 0,
            toolEvents: [],
        } satisfies AgentTurnResult);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [
                    { when: /First blocked prompt/, reply: 'one' },
                    { when: /Second blocked prompt/, reply: 'two' },
                ],
            },
            makeDeps({ sendTurn }),
        );

        expect(sendTurn).toHaveBeenCalledTimes(1);
        expect(result.turns).toBe(1);
        expect(result.completionReason).toBe('maxTurns');
    });

    it('23: reactions match the active blocked prompt instead of hidden completion text', async () => {
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'done',
                assistantMessage: 'done',
                visibleAssistantMessage: 'Need approval',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'Need approval',
                        options: [],
                        sourceTool: 'AskUserQuestion',
                        order: 0,
                    },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'finished',
                assistantMessage: 'finished',
                visibleAssistantMessage: 'finished',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until: ({ lastMessage }) => lastMessage === 'finished',
                reactions: [
                    { when: /done/, reply: 'Wrong reply' },
                    { when: /approval/, reply: 'Approved' },
                ],
            },
            makeDeps({ sendTurn }),
        );

        expect(sendTurn.mock.calls.map(([message]) => message)).toEqual(['Start', 'Approved']);
        expect(result.reactionsFired).toEqual([
            {
                turn: 1,
                reactionIndex: 1,
                pattern: '/approval/',
                reply: 'Approved',
            },
        ]);
    });

    it('24: persona fallback replies to the active blocked prompt', async () => {
        const deps = makeDeps();
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'summary hidden from reactions',
                assistantMessage: 'summary hidden from reactions',
                visibleAssistantMessage: 'Which option should I pick?',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'Which option should I pick?',
                        options: [],
                        sourceTool: 'AskUserQuestion',
                        order: 0,
                    },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'thanks',
                assistantMessage: 'thanks',
                visibleAssistantMessage: 'thanks',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);
        const personaReply = vi.fn(async () => {
            expect(deps.messages.at(-1)?.content).toBe('Which option should I pick?');
            return 'Persona answer';
        });

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until: ({ lastMessage }) => lastMessage === 'thanks',
            },
            { ...deps, sendTurn, personaReply },
        );

        expect(personaReply).toHaveBeenCalledOnce();
        expect(sendTurn.mock.calls.map(([message]) => message)).toEqual(['Start', 'Persona answer']);
        expect(result.completionReason).toBe('until');
    });

    it('25: logs blocked prompt provenance without inflating model turn diagnostics', async () => {
        const log: LogEntry[] = [];
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'hidden completion summary',
                assistantMessage: 'hidden completion summary',
                visibleAssistantMessage: 'First blocked prompt',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'First blocked prompt',
                        options: [],
                        sourceTool: 'AskUserQuestion',
                        toolUseId: 'toolu_first',
                        order: 0,
                    },
                    {
                        prompt: 'Second blocked prompt',
                        options: [],
                        sourceTool: 'AskUserQuestion',
                        toolUseId: 'toolu_second',
                        order: 1,
                    },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'done',
                assistantMessage: 'done',
                visibleAssistantMessage: 'done',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until: ({ lastMessage }) => lastMessage === 'done',
                reactions: [
                    { when: /First blocked prompt/, reply: 'one' },
                    { when: /Second blocked prompt/, reply: 'two' },
                ],
            },
            makeDeps({ sendTurn, log }),
        );

        expect(result.turnDetails).toHaveLength(2);

        const blockedTurn = log.find((entry) =>
            entry.type === 'agent_result' && entry.assistant_message === 'First blocked prompt',
        );
        expect(blockedTurn).toMatchObject({
            assistant_message_source: 'blocked_prompt',
            raw_assistant_message: 'hidden completion summary',
            blocked_prompt_index: 0,
            blocked_prompt_count: 2,
            blocked_prompt_source_tool: 'AskUserQuestion',
            blocked_prompt_tool_use_id: 'toolu_first',
        });

        const syntheticReplay = log.find((entry) =>
            entry.type === 'agent_result' && entry.assistant_message === 'Second blocked prompt',
        );
        expect(syntheticReplay).toMatchObject({
            assistant_message_source: 'blocked_prompt',
            synthetic_blocked_prompt: true,
            blocked_prompt_source_turn: 1,
            blocked_prompt_index: 1,
            blocked_prompt_count: 2,
            blocked_prompt_source_tool: 'AskUserQuestion',
            blocked_prompt_tool_use_id: 'toolu_second',
        });
    });

    it('26: normalizes queued blocked-prompt replies to an exact option label when uniquely implied', async () => {
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'hidden completion summary',
                assistantMessage: 'hidden completion summary',
                visibleAssistantMessage: '**Routing**\nHow should these two insights be routed?\n- **Apply suggested routing** - Apply both insights.\n- **Skip these items** - Record but do not edit.\n- **Review one by one** - Decide separately.',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'How should these two insights be routed?',
                        header: 'Routing',
                        options: [
                            { label: 'Apply suggested routing', description: 'Apply both insights.' },
                            { label: 'Skip these items', description: 'Record but do not edit.' },
                            { label: 'Review one by one', description: 'Decide separately.' },
                        ],
                        sourceTool: 'AskUserQuestion',
                        order: 0,
                    },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'done',
                assistantMessage: 'done',
                visibleAssistantMessage: 'done',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);

        await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until: ({ lastMessage }) => lastMessage === 'done',
                reactions: [
                    { when: /How should these two insights be routed\?/, reply: 'Apply' },
                ],
            },
            makeDeps({ sendTurn }),
        );

        expect(sendTurn.mock.calls.map(([message]) => message)).toEqual([
            'Start',
            'Apply suggested routing',
        ]);
    });

    it('27: runtime policy metadata does not override blocked-prompt replay or reaction matching', async () => {
        const sendTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'I know what to do already.',
                assistantMessage: 'I know what to do already.',
                visibleAssistantMessage: 'Need approval',
                visibleAssistantMessageSource: 'blocked_prompt',
                blockedPrompts: [
                    {
                        prompt: 'Need approval',
                        options: [],
                        sourceTool: 'AskUserQuestion',
                        order: 0,
                    },
                ],
                runtimePoliciesApplied: [
                    { id: 'noninteractive-user-question', version: '1' },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce({
                rawOutput: 'finished',
                assistantMessage: 'finished',
                visibleAssistantMessage: 'finished',
                visibleAssistantMessageSource: 'assistant_message',
                blockedPrompts: [],
                runtimePoliciesApplied: [
                    { id: 'noninteractive-user-question', version: '1' },
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult);

        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                until: ({ lastMessage }) => lastMessage === 'finished',
                reactions: [
                    { when: /Runtime policy/, reply: 'Wrong reply' },
                    { when: /approval/, reply: 'Approved' },
                ],
            },
            makeDeps({ sendTurn }),
        );

        expect(sendTurn.mock.calls.map(([message]) => message)).toEqual(['Start', 'Approved']);
        expect(result.reactionsFired).toEqual([
            {
                turn: 1,
                reactionIndex: 1,
                pattern: '/approval/',
                reply: 'Approved',
            },
        ]);
    });

    it('28: logs user reply text in session_log entries', async () => {
        const log: LogEntry[] = [];
        const sendTurn = vi.fn()
            .mockResolvedValueOnce('Please confirm your choice.')
            .mockResolvedValueOnce('done');

        await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /confirm/, reply: 'Looks good, continue' }],
            },
            makeDeps({ sendTurn, log }),
        );

        expect(log.find((entry) => entry.type === 'user_reply')).toMatchObject({
            instruction: 'Looks good, continue',
            turn_number: 2,
        });
    });
});
