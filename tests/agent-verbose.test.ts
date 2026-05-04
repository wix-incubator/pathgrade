import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnResult } from '../src/types.js';

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

function makeTurnResult(message: string, toolEvents: AgentTurnResult['toolEvents'] = []): AgentTurnResult {
    return {
        rawOutput: message,
        assistantMessage: message,
        visibleAssistantMessage: message,
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        blockedPrompts: [],
        toolEvents,
    };
}

function makeWorkspace() {
    return {
        path: '/tmp/pathgrade-verbose-test',
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        dispose: vi.fn().mockResolvedValue(undefined),
        setupCommands: [],
        mcpConfigPath: undefined,
    };
}

function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

beforeEach(() => {
    delete process.env.PATHGRADE_VERBOSE;
});

afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PATHGRADE_VERBOSE;
});

describe('agent verbose wiring', () => {
    it('produces zero sink writes when PATHGRADE_VERBOSE is unset', async () => {
        const lines: string[] = [];
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('hello')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent, __setVerboseSinkForTesting } = await import('../src/sdk/agent.js');
        __setVerboseSinkForTesting({ write: (l) => lines.push(l) });
        try {
            const agent = await createAgent({ timeout: 300 });
            await agent.prompt('hello');
        } finally {
            __setVerboseSinkForTesting(null);
        }
        expect(lines).toEqual([]);
    });

    it('emits turnStart/turnEnd when PATHGRADE_VERBOSE=1 (prompt)', async () => {
        process.env.PATHGRADE_VERBOSE = '1';
        const lines: string[] = [];
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('Hi there')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent, __setVerboseSinkForTesting } = await import('../src/sdk/agent.js');
        __setVerboseSinkForTesting({ write: (l) => lines.push(l) });
        try {
            const agent = await createAgent({ timeout: 300 });
            await agent.prompt('Create a file');
        } finally {
            __setVerboseSinkForTesting(null);
        }

        const stripped = lines.map(stripAnsi);
        const start = stripped.find((l) => l.startsWith('→ Turn 1'));
        const end = stripped.find((l) => l.startsWith('← Turn 1'));
        expect(start).toMatch(/^→ Turn 1 \[agent_start\] "Create a file"$/);
        expect(end).toMatch(/^← Turn 1  /);
    });

    it('emits tool_event lines between turn_start and turn_end', async () => {
        process.env.PATHGRADE_VERBOSE = '1';
        const lines: string[] = [];
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        const toolEvents: AgentTurnResult['toolEvents'] = [
            {
                action: 'read_file',
                provider: 'claude',
                providerToolName: 'Read',
                summary: 'src/foo.ts',
                confidence: 'high',
                rawSnippet: '',
            },
            {
                action: 'write_file',
                provider: 'claude',
                providerToolName: 'Write',
                summary: 'hello.txt',
                confidence: 'high',
                rawSnippet: '',
            },
        ];
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult('ok', toolEvents)),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent, __setVerboseSinkForTesting } = await import('../src/sdk/agent.js');
        __setVerboseSinkForTesting({ write: (l) => lines.push(l) });
        try {
            const agent = await createAgent({ timeout: 300 });
            await agent.prompt('do it');
        } finally {
            __setVerboseSinkForTesting(null);
        }

        const stripped = lines.map(stripAnsi);
        const turnStartIdx = stripped.findIndex((l) => l.startsWith('→ Turn 1'));
        const turnEndIdx = stripped.findIndex((l) => l.startsWith('← Turn 1'));
        const between = stripped.slice(turnStartIdx + 1, turnEndIdx);
        expect(between).toEqual([
            '  · read_file src/foo.ts',
            '  · write_file hello.txt',
        ]);
    });

    it('startChat + reply emits two turn blocks', async () => {
        process.env.PATHGRADE_VERBOSE = '1';
        const lines: string[] = [];
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn()
                .mockResolvedValueOnce(makeTurnResult('first'))
                .mockResolvedValueOnce(makeTurnResult('second')),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
        });

        const { createAgent, __setVerboseSinkForTesting } = await import('../src/sdk/agent.js');
        __setVerboseSinkForTesting({ write: (l) => lines.push(l) });
        try {
            const agent = await createAgent({ timeout: 300 });
            const chat = await agent.startChat('hello');
            await chat.reply('again');
        } finally {
            __setVerboseSinkForTesting(null);
        }

        const stripped = lines.map(stripAnsi);
        const turnStarts = stripped.filter((l) => l.startsWith('→ Turn'));
        const turnEnds = stripped.filter((l) => l.startsWith('← Turn'));
        expect(turnStarts).toEqual([
            '→ Turn 1 [agent_start] "hello"',
            '→ Turn 2 [user_reply] "again"',
        ]);
        expect(turnEnds.length).toBe(2);
        expect(turnEnds[0]).toMatch(/^← Turn 1  /);
        expect(turnEnds[1]).toMatch(/^← Turn 2  /);
    });
});
