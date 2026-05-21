/**
 * Repro for the Pathgrade `AskUserQuestion` harness bug filed in
 * `pathgrade-ask-user-harness-bug.md`.
 *
 * Symptom under `agent.prompt(...)`:
 *   1. Claude SDK driver fires `AskUserQuestion`.
 *   2. The default per-conversation `AskBus` (created inside
 *      `createManagedSession`) has no subscriber under `prompt()` —
 *      `runConversation` is what wires the `createAskUserHandler` subscriber.
 *   3. The bridge times out at `askUserTimeoutMs` (30s default), denies the
 *      SDK tool, the projector reports `exitCode: 1` + `errorSubtype:
 *      'bus_rejection'` + `rawOutput: <ask-bus error message>`.
 *   4. `AgentImpl.executeLoggedTurnResult` throws `Agent exited with code 1`
 *      without surfacing the rawOutput or errorSubtype — masking the actual
 *      cause so the eval failure looks like a product regression.
 *
 * These tests assert the *fixed* behavior: the throw from `prompt()` must
 * include the rawOutput detail and the errorSubtype, matching what
 * `runConversation` already does via `buildTurnExitError`.
 */

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

function makeWorkspace() {
    return {
        path: '/tmp/pathgrade-prompt-crash-test',
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        dispose: vi.fn().mockResolvedValue(undefined),
        setupCommands: [],
        mcpConfigPath: undefined,
        env: {},
    };
}

function busRejectionTurnResult(): AgentTurnResult {
    // Exact shape the Claude SDK driver returns after the ask-bus rejects a
    // live batch — see `src/agents/claude.ts:178` + the projector at
    // `src/agents/claude/sdk-message-projector.ts:134`.
    return {
        rawOutput: 'ask_user batch toolu-x on turn 1 did not resolve within 30000ms',
        assistantMessage: '',
        visibleAssistantMessage: '',
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 1,
        errorSubtype: 'bus_rejection',
        toolEvents: [
            {
                action: 'ask_user',
                provider: 'claude',
                providerToolName: 'AskUserQuestion',
                turnNumber: 1,
                arguments: { questions: [{ question: 'Pick one?' }], answerSource: 'unknown' },
                summary: 'ask_user "AskUserQuestion"',
                confidence: 'high',
                rawSnippet: '{...}',
            },
        ],
        runtimePoliciesApplied: [],
    };
}

beforeEach(() => {
    delete process.env.PATHGRADE_VERBOSE;
});
afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PATHGRADE_VERBOSE;
});

describe('AgentImpl.prompt() — Claude ask-bus rejection surfaces actionable detail', () => {
    it('throws an Error whose message includes the bus rejection detail and errorSubtype', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(busRejectionTurnResult()),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
            dispose: vi.fn().mockResolvedValue(undefined),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 30, agent: 'claude' });

        // The bug: previously this throw was just "Agent exited with code 1"
        // — masking the bus-rejection detail the projector + driver already
        // captured on `rawOutput` / `errorSubtype`.
        let captured: Error | undefined;
        try {
            await agent.prompt('go');
        } catch (err) {
            captured = err as Error;
        }
        expect(captured).toBeInstanceOf(Error);
        expect(captured?.message).toMatch(/did not resolve within 30000ms/);
        expect(captured?.message).toMatch(/bus_rejection/);
    });

    it('still surfaces "Agent exited with code N" so existing matchers keyed on that prefix continue to work', async () => {
        prepareWorkspaceMock.mockResolvedValue(makeWorkspace());
        createManagedSessionMock.mockReturnValue({
            executeTurn: vi.fn().mockResolvedValue(busRejectionTurnResult()),
            send: vi.fn(),
            remainingMs: vi.fn().mockReturnValue(300_000),
            dispose: vi.fn().mockResolvedValue(undefined),
        });

        const { createAgent } = await import('../src/sdk/agent.js');
        const agent = await createAgent({ timeout: 30, agent: 'claude' });

        await expect(agent.prompt('go')).rejects.toThrow(/Agent exited with code 1/);
    });
});
