import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnResult } from '../src/types.js';
import { buildDiagnosticsReport } from '../src/reporters/diagnostics.js';

const prepareWorkspaceMock = vi.fn();
const createManagedSessionMock = vi.fn();
const trackAgentMock = vi.fn();
const untrackAgentMock = vi.fn();

vi.mock('../src/providers/workspace', () => ({
    prepareWorkspace: (...args: unknown[]) => prepareWorkspaceMock(...args),
}));

vi.mock('../src/sdk/managed-session', () => ({
    createManagedSession: (...args: unknown[]) => createManagedSessionMock(...args),
}));

vi.mock('../src/plugin/lifecycle', () => ({
    lifecycle: {
        trackAgent: (...args: unknown[]) => trackAgentMock(...args),
        untrackAgent: (...args: unknown[]) => untrackAgentMock(...args),
    },
}));

function makeTurnResult(message: string): AgentTurnResult {
    return {
        rawOutput: message,
        assistantMessage: message,
        visibleAssistantMessage: message,
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        blockedPrompts: [],
        toolEvents: [],
    };
}

function makeWorkspace() {
    return {
        path: '/tmp/pathgrade-agent-test',
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        dispose: vi.fn().mockResolvedValue(undefined),
        setupCommands: [],
        mcpConfigPath: undefined,
    };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('createAgent timeout:auto and runtime diagnostics', () => {
    it('rejects timeout:auto for prompt()', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn(),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(1_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 'auto' });

        await expect(agent.prompt('hello')).rejects.toThrow(
            "timeout: 'auto' is only supported for runConversation()",
        );
    });

    it('rejects timeout:auto for startChat()', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn(),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(1_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 'auto' });

        await expect(agent.startChat('hello')).rejects.toThrow(
            "timeout: 'auto' is only supported for runConversation()",
        );
    });

    it('resolves timeout:auto from maxTurns for runConversation()', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('done')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(520_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 'auto' });

        await agent.runConversation({
            firstMessage: 'hello',
            maxTurns: 4,
            until: () => true,
        });

        expect(createManagedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            timeoutSec: 520,
        }));
    });

    it('uses the default maxTurns when resolving timeout:auto', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('done')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(2_600_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 'auto' });

        await agent.runConversation({
            firstMessage: 'hello',
            until: () => true,
        });

        expect(createManagedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            timeoutSec: 2600,
        }));
    });

    it('passes explicit codex models into managed session creation', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('done')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ agent: 'codex', model: 'gpt-5.3-codex', timeout: 300 });

        await agent.prompt('hello');

        expect(createManagedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5.3-codex',
        }));
    });

    it('prompt() logs single-turn output size diagnostics', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('line 1\nline 2')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 300 });

        await expect(agent.prompt('hello')).resolves.toBe('line 1\nline 2');

        const agentResultEntry = agent.log.find((entry: any) => entry.type === 'agent_result');
        expect(agentResultEntry).toMatchObject({
            turn_number: 1,
            output_lines: 2,
            output_chars: 'line 1\nline 2'.length,
        });
        expect(agentResultEntry?.duration_ms).toBeTypeOf('number');
    });

    it('startChat() records diagnostics for the opener and replies', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn()
                .mockResolvedValueOnce(makeTurnResult('first line'))
                .mockResolvedValueOnce(makeTurnResult('second\nreply')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 300 });

        const chat = await agent.startChat('hello');
        await chat.reply('again');

        const agentResults = agent.log.filter((entry: any) => entry.type === 'agent_result');
        expect(agentResults).toHaveLength(2);
        expect(agentResults[0]).toMatchObject({
            turn_number: 1,
            output_lines: 1,
            output_chars: 'first line'.length,
        });
        expect(agentResults[1]).toMatchObject({
            turn_number: 2,
            output_lines: 2,
            output_chars: 'second\nreply'.length,
        });
        expect(agent.log.find((entry: any) => entry.type === 'user_reply')).toMatchObject({
            instruction: 'again',
            turn_number: 2,
        });
    });

    it('uses the visible blocked prompt text for both runConversation() and startChat()', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue({
                rawOutput: 'I already know what I want to do.',
                assistantMessage: 'I already know what I want to do.',
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
                ],
                exitCode: 0,
                toolEvents: [],
            } satisfies AgentTurnResult),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');

        const conversationAgent = await createAgent({ timeout: 300 });
        const conversationResult = await conversationAgent.runConversation({
            firstMessage: 'hello',
            until: () => true,
        });

        expect(conversationResult.turns).toBe(1);
        expect(conversationAgent.messages[1]?.content).toBe('**Approval**\nShould I proceed?\n- **Yes** - Continue\n- **No** - Stop');
        expect(conversationAgent.log.find((entry: any) => entry.type === 'agent_result')).toMatchObject({
            assistant_message: '**Approval**\nShould I proceed?\n- **Yes** - Continue\n- **No** - Stop',
        });

        const chatAgent = await createAgent({ timeout: 300 });
        const chat = await chatAgent.startChat('hello');

        expect(chat.lastMessage).toBe('**Approval**\nShould I proceed?\n- **Yes** - Continue\n- **No** - Stop');
        expect(chatAgent.messages[1]?.content).toBe('**Approval**\nShould I proceed?\n- **Yes** - Continue\n- **No** - Stop');
    });

    it('startChat() replays queued blocked prompts locally before resuming model execution', async () => {
        const executeTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'I already know the answer.',
                assistantMessage: 'I already know the answer.',
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
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce(makeTurnResult('Queue resolved'));
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn,
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 300 });

        const chat = await agent.startChat('hello');
        expect(chat.turn).toBe(1);
        expect(chat.lastMessage).toBe('First blocked prompt');

        await chat.reply('answer one');
        expect(executeTurn).toHaveBeenCalledTimes(1);
        expect(chat.turn).toBe(1);
        expect(chat.lastMessage).toBe('Second blocked prompt');

        await chat.reply('answer two');
        expect(executeTurn).toHaveBeenCalledTimes(2);
        expect(executeTurn.mock.calls[1]?.[0]).toBe('answer two');
        expect(chat.turn).toBe(2);
        expect(chat.lastMessage).toBe('Queue resolved');
    });

    it('startChat() does not count synthetic blocked prompt replays as model turns in diagnostics', async () => {
        const executeTurn = vi.fn()
            .mockResolvedValueOnce({
                rawOutput: 'I already know the answer.',
                assistantMessage: 'I already know the answer.',
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
            } satisfies AgentTurnResult)
            .mockResolvedValueOnce(makeTurnResult('Queue resolved'));
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn,
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 300 });

        const chat = await agent.startChat('hello');
        await chat.reply('answer one');
        await chat.reply('answer two');

        const syntheticReplay = agent.log.find((entry: any) =>
            entry.type === 'agent_result' && entry.assistant_message === 'Second blocked prompt',
        );
        expect(syntheticReplay).toMatchObject({
            synthetic_blocked_prompt: true,
            blocked_prompt_source_turn: 1,
        });
        expect(syntheticReplay).not.toHaveProperty('turn_number');
        expect(syntheticReplay).not.toHaveProperty('duration_ms');

        const diagnostics = buildDiagnosticsReport({ log: agent.log });
        expect(diagnostics.turns).toBe(2);
        expect(diagnostics.turnDetails).toEqual([
            expect.objectContaining({ turn: 1 }),
            expect.objectContaining({ turn: 2 }),
        ]);
    });
});
