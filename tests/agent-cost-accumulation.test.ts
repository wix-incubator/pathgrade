/**
 * Tests for per-turn cost accumulation through the AgentImpl runConversation
 * path.
 *
 * The Claude SDK projector populates `AgentTurnResult.costUsd` from the SDK's
 * `total_cost_usd`. AgentImpl's `sendTurn` accumulates that onto the agent's
 * shared LLM tracker via `addCost` exactly as it accumulates `inputTokens` /
 * `outputTokens` via `addTokens` today (`src/sdk/agent.ts` token-attribution
 * block). The pre-evaluate snapshot of `llm.costUsd` becomes
 * `TrialResult.conversation_cost_usd` (covered separately in the evaluate
 * tests).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

function makeTurnResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
    return {
        rawOutput: 'done',
        assistantMessage: 'done',
        visibleAssistantMessage: 'done',
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        toolEvents: [],
        ...overrides,
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

describe('AgentImpl runConversation — cost accumulation', () => {
    it('adds turn costUsd to the shared LLM tracker via addCost', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        const turn1 = makeTurnResult({ costUsd: 0.0125 });
        const turn2 = makeTurnResult({ costUsd: 0.0008 });
        const executeTurn = vi.fn()
            .mockResolvedValueOnce(turn1)
            .mockResolvedValueOnce(turn2);
        createManagedSessionMock.mockReturnValue({
            executeTurn,
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(60_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 60 });

        let runs = 0;
        await agent.runConversation({
            firstMessage: 'hello',
            maxTurns: 4,
            // Stop after the second turn so two costed turns flow through.
            // Reaction supplies a reply so we don't need a persona.
            reactions: [{ when: /done/, reply: 'continue' }],
            until: () => ++runs >= 2,
        });

        // Sum of the two SDK-reported turn costs accumulated onto the
        // shared tracker. Tolerance is generous because pathgrade does
        // no rounding — direct addition with floating-point noise only.
        expect(agent.llm.costUsd).toBeCloseTo(0.0133, 10);
    });

    it('does not call addCost when the turn result has no costUsd (Codex / Cursor today)', async () => {
        // Drivers that don't expose turn cost leave `costUsd` undefined,
        // and the accumulator must stay
        // at zero — never default an undefined-cost turn to a zero-cost
        // turn, because that would falsely imply "free" in run reports.
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(makeTurnResult()),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(60_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 60 });

        await agent.runConversation({
            firstMessage: 'hello',
            maxTurns: 1,
            until: () => true,
        });

        expect(agent.llm.costUsd).toBe(0);
    });

    it('still accumulates tokens when costUsd is set (regression: addTokens path unchanged)', async () => {
        // Anchor: the new addCost call must not displace or short-circuit
        // the existing addTokens accumulation. Cost is *additive* alongside
        // tokens; the cost path must not gate the token path.
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        const turn = makeTurnResult({
            inputTokens: 100,
            outputTokens: 25,
            costUsd: 0.001,
        });
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(turn),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(60_000),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 60 });

        await agent.runConversation({
            firstMessage: 'hello',
            maxTurns: 1,
            until: () => true,
        });

        expect(agent.llm.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 25 });
        expect(agent.llm.costUsd).toBeCloseTo(0.001, 10);
    });
});

describe('AgentImpl prompt/startChat — token & cost accumulation', () => {
    it('prompt() accumulates tokens and cost onto the shared LLM tracker', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(
                makeTurnResult({ inputTokens: 200, outputTokens: 50, costUsd: 0.0042 }),
            ),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(60_000),
            dispose: vi.fn().mockResolvedValue(undefined),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 60 });
        await agent.prompt('hi');

        expect(agent.llm.tokenUsage).toEqual({ inputTokens: 200, outputTokens: 50 });
        expect(agent.llm.costUsd).toBeCloseTo(0.0042, 10);
    });

    it('startChat() first turn + chat.reply() turns both accumulate tokens and cost', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        const executeTurn = vi.fn()
            .mockResolvedValueOnce(
                makeTurnResult({ inputTokens: 100, outputTokens: 20, costUsd: 0.001 }),
            )
            .mockResolvedValueOnce(
                makeTurnResult({ inputTokens: 150, outputTokens: 30, costUsd: 0.002 }),
            );
        createManagedSessionMock.mockReturnValue({
            executeTurn,
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(60_000),
            dispose: vi.fn().mockResolvedValue(undefined),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 60 });
        const chat = await agent.startChat('hello');
        await chat.reply('continue');

        expect(agent.llm.tokenUsage).toEqual({ inputTokens: 250, outputTokens: 50 });
        expect(agent.llm.costUsd).toBeCloseTo(0.003, 10);
    });
});
