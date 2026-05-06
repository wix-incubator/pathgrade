import { describe, it, expect } from 'vitest';
import {
    resolveAgentName,
    resolveCodexTransport,
    InvalidTransportEnvError,
} from '../src/sdk/agent-resolution.js';
import { createAgentEnvironment } from '../src/agents/registry.js';
import { CodexAgent } from '../src/agents/codex.js';
import { CodexAppServerAgent } from '../src/agents/codex-app-server/agent.js';
import { ClaudeAgent } from '../src/agents/claude.js';
import { CursorAgent } from '../src/agents/cursor.js';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { Message } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';

describe('resolveAgentName (option-over-env)', () => {
    it('prefers opts.agent over PATHGRADE_AGENT env var', () => {
        expect(resolveAgentName({ agent: 'claude' }, { PATHGRADE_AGENT: 'codex' })).toBe('claude');
    });

    it('falls back to PATHGRADE_AGENT when no option is given', () => {
        expect(resolveAgentName({}, { PATHGRADE_AGENT: 'codex' })).toBe('codex');
    });

    it("defaults to 'claude' when neither option nor env is set", () => {
        expect(resolveAgentName({}, {})).toBe('claude');
    });

    it('option wins even when env is set to a different valid agent', () => {
        expect(resolveAgentName({ agent: 'cursor' }, { PATHGRADE_AGENT: 'codex' })).toBe('cursor');
    });
});

describe('resolveCodexTransport', () => {
    it("defaults to 'app-server' when neither option nor env is set", () => {
        expect(resolveCodexTransport({}, {})).toBe('app-server');
    });

    it('uses opts.transport when provided', () => {
        expect(resolveCodexTransport({ transport: 'exec' }, {})).toBe('exec');
        expect(resolveCodexTransport({ transport: 'app-server' }, {})).toBe('app-server');
    });

    it('uses PATHGRADE_CODEX_TRANSPORT env var when no option is given', () => {
        expect(resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'exec' })).toBe('exec');
        expect(resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'app-server' })).toBe('app-server');
    });

    it('prefers opts.transport over env (option-over-env)', () => {
        expect(
            resolveCodexTransport({ transport: 'app-server' }, { PATHGRADE_CODEX_TRANSPORT: 'exec' }),
        ).toBe('app-server');
        expect(
            resolveCodexTransport({ transport: 'exec' }, { PATHGRADE_CODEX_TRANSPORT: 'app-server' }),
        ).toBe('exec');
    });

    it('throws InvalidTransportEnvError on invalid env value, citing the bad value and valid options', () => {
        expect(() => resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'bogus' })).toThrow(
            InvalidTransportEnvError,
        );
        try {
            resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: 'bogus' });
        } catch (err) {
            expect(String((err as Error).message)).toMatch(/bogus/);
            expect(String((err as Error).message)).toMatch(/exec/);
            expect(String((err as Error).message)).toMatch(/app-server/);
        }
    });

    it('does NOT throw on empty/undefined env value (falls through to default)', () => {
        expect(resolveCodexTransport({}, { PATHGRADE_CODEX_TRANSPORT: '' })).toBe('app-server');
        expect(resolveCodexTransport({}, {})).toBe('app-server');
    });
});

describe('createAgentEnvironment transport-aware routing', () => {
    it('routes codex + app-server (default) to CodexAppServerAgent', () => {
        expect(createAgentEnvironment('codex', 'app-server')).toBeInstanceOf(CodexAppServerAgent);
    });

    it('routes codex + exec to CodexAgent', () => {
        expect(createAgentEnvironment('codex', 'exec')).toBeInstanceOf(CodexAgent);
    });

    it('defaults codex (no transport arg) to CodexAppServerAgent', () => {
        expect(createAgentEnvironment('codex')).toBeInstanceOf(CodexAppServerAgent);
    });

    it('ignores transport for claude', () => {
        expect(createAgentEnvironment('claude', 'app-server')).toBeInstanceOf(ClaudeAgent);
        expect(createAgentEnvironment('claude', 'exec')).toBeInstanceOf(ClaudeAgent);
        expect(createAgentEnvironment('claude')).toBeInstanceOf(ClaudeAgent);
    });

    it('ignores transport for cursor', () => {
        expect(createAgentEnvironment('cursor', 'app-server')).toBeInstanceOf(CursorAgent);
        expect(createAgentEnvironment('cursor', 'exec')).toBeInstanceOf(CursorAgent);
        expect(createAgentEnvironment('cursor')).toBeInstanceOf(CursorAgent);
    });
});

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

describe("runConversation guard: transport 'exec' + AskUserReaction", () => {
    it('fails fast before any turn runs when transport is exec and an AskUserReaction is present', async () => {
        let sendTurnCalled = false;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [
                    { whenAsked: /anything/, answer: 'yes' },
                ],
            },
            makeDeps({
                askBus: createAskBus({ askUserTimeoutMs: 1000 }),
                transport: 'exec',
                agentName: 'codex',
                sendTurn: async () => {
                    sendTurnCalled = true;
                    return 'should not be called';
                },
            }),
        );

        expect(sendTurnCalled).toBe(false);
        expect(result.completionReason).toBe('error');
        expect(result.completionDetail).toMatch(
            /AskUserReaction defined but transport is 'exec'; the handshake cannot fire under exec mode/,
        );
    });

    it('does NOT fail when transport is exec but no AskUserReaction is present (text reactions ok)', async () => {
        let sendTurnCalled = false;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [{ when: /x/, reply: 'hi' }],
            },
            makeDeps({
                askBus: createAskBus({ askUserTimeoutMs: 1000 }),
                transport: 'exec',
                agentName: 'codex',
                sendTurn: async () => {
                    sendTurnCalled = true;
                    return 'ok';
                },
            }),
        );

        expect(sendTurnCalled).toBe(true);
        expect(result.completionReason).toBe('maxTurns');
    });

    it('is silenced by allowUnreachableReactions: true', async () => {
        let sendTurnCalled = false;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [{ whenAsked: /q/, answer: 'yes' }],
                allowUnreachableReactions: true,
            },
            makeDeps({
                askBus: createAskBus({ askUserTimeoutMs: 1000 }),
                transport: 'exec',
                agentName: 'codex',
                sendTurn: async () => {
                    sendTurnCalled = true;
                    return 'ok';
                },
            }),
        );

        expect(sendTurnCalled).toBe(true);
        expect(result.completionReason).toBe('maxTurns');
    });

    it('does NOT block Claude conversations with AskUserReaction — Claude transport is reliable (#007)', async () => {
        // Pre-#004 Claude was `'noninteractive'` and the legacy CLI driver
        // synthesized blocked-prompt envelopes from CLI denial output to
        // approximate ask-user behavior. The preflight on `transport: 'exec'`
        // never fired for Claude because `transport` is a Codex-only field;
        // post-#004 + #007 the *justification* for that hands-off behavior is
        // also right — Claude routes AskUserQuestion through the live ask-user
        // bridge (capability `'reliable'`), so reactions are reachable.
        // Lock in: the conversation runner does not refuse to start a Claude
        // conversation that defines an AskUserReaction.
        let sendTurnCalled = false;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [{ whenAsked: /q/, answer: 'yes' }],
            },
            makeDeps({
                askBus: createAskBus({ askUserTimeoutMs: 1000 }),
                // No transport — Claude is not transport-gated.
                agentName: 'claude',
                sendTurn: async () => {
                    sendTurnCalled = true;
                    return 'ok';
                },
            }),
        );

        expect(sendTurnCalled).toBe(true);
        expect(result.completionReason).toBe('maxTurns');
        // Bonus: no error / unmatched detail surfaces.
        expect(result.completionDetail).toBeUndefined();
    });

    it('does not trigger under transport app-server (reactions deliverable)', async () => {
        let sendTurnCalled = false;
        const result = await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 1,
                reactions: [{ whenAsked: /q/, answer: 'yes' }],
            },
            makeDeps({
                askBus: createAskBus({ askUserTimeoutMs: 1000 }),
                transport: 'app-server',
                agentName: 'codex',
                sendTurn: async () => {
                    sendTurnCalled = true;
                    return 'ok';
                },
            }),
        );

        expect(sendTurnCalled).toBe(true);
        expect(result.completionReason).toBe('maxTurns');
    });
});
