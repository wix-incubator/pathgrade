import { describe, expect, it } from 'vitest';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import { createAskUserAnswerStore } from '../src/agents/claude/ask-user-answer-store.js';
import { createClaudeToolPermissionBridge } from '../src/agents/claude/tool-permission-bridge.js';
import { createClaudeDeniedMcpEventStore } from '../src/agents/claude/denied-mcp-event-store.js';
import { findMcpToolCalls } from '../src/sdk/mcp-evidence.js';

const PERMISSION_CTX = {
    signal: new AbortController().signal,
    suggestions: [],
    toolUseID: 'tool-use-test',
};

function bridge(overrides: Partial<Parameters<typeof createClaudeToolPermissionBridge>[0]> = {}) {
    const askBus = createAskBus({ askUserTimeoutMs: 1000 });
    return {
        askBus,
        canUseTool: createClaudeToolPermissionBridge({
            askBus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
            mcpServerNames: ['docs'],
            mcpSafety: { runMode: 'live-readonly', liveOptIn: true },
            ...overrides,
        }),
    };
}

describe('Claude MCP tool-permission bridge', () => {
    it('delegates AskUserQuestion to the existing ask-user behavior', async () => {
        const { askBus, canUseTool } = bridge();
        askBus.onAsk((batch, respond) => {
            respond({
                answers: [
                    { questionId: batch.questions[0].id, values: ['SQLite'], source: 'reaction' },
                ],
            });
        });

        const result = await canUseTool(
            'AskUserQuestion',
            { questions: [{ question: 'Database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] },
            PERMISSION_CTX,
        );

        expect(result.behavior).toBe('allow');
        if (result.behavior !== 'allow') return;
        expect(result.updatedInput).toMatchObject({
            answers: { 'Database?': 'SQLite' },
        });
    });

    it('allows non-MCP Claude tools with their original input', async () => {
        const { canUseTool } = bridge();
        const input = { command: 'npm test' };

        await expect(canUseTool('Bash', input, PERMISSION_CTX)).resolves.toEqual({
            behavior: 'allow',
            updatedInput: input,
        });
    });

    it('allows allowlisted readonly MCP tools with their original input', async () => {
        const { canUseTool } = bridge({
            mcpSafety: {
                runMode: 'live-readonly',
                liveOptIn: true,
                mcpToolPolicy: {
                    allow: [{ serverName: 'docs', toolName: 'search', readonly: true }],
                },
            },
        });
        const input = { query: 'mcp' };

        await expect(canUseTool('mcp__docs__search', input, PERMISSION_CTX)).resolves.toEqual({
            behavior: 'allow',
            updatedInput: input,
        });
    });

    it('denies denylisted and not-allowlisted MCP tools', async () => {
        const { canUseTool } = bridge({
            mcpSafety: {
                runMode: 'live-sandbox',
                liveOptIn: true,
                mcpToolPolicy: {
                    allow: [{ serverName: 'docs', toolName: 'search' }],
                    deny: [{ serverName: 'docs', toolName: 'delete' }],
                },
            },
        });

        await expect(canUseTool('mcp__docs__delete', {}, PERMISSION_CTX)).resolves.toMatchObject({
            behavior: 'deny',
            message: expect.stringMatching(/denied by policy/),
        });
        await expect(canUseTool('mcp__docs__write', {}, PERMISSION_CTX)).resolves.toMatchObject({
            behavior: 'deny',
            message: expect.stringMatching(/not allowlisted/),
        });
    });

    it('denies live-readonly MCP calls without explicit readonly policy', async () => {
        const missingPolicy = bridge({
            mcpSafety: { runMode: 'live-readonly', liveOptIn: true },
        }).canUseTool;
        await expect(missingPolicy('mcp__docs__search', {}, PERMISSION_CTX)).resolves.toMatchObject({
            behavior: 'deny',
            message: expect.stringMatching(/explicit mcpToolPolicy/),
        });

        const notReadonly = bridge({
            mcpSafety: {
                runMode: 'live-readonly',
                liveOptIn: true,
                mcpToolPolicy: { allow: [{ serverName: 'docs', toolName: 'search' }] },
            },
        }).canUseTool;
        await expect(notReadonly('mcp__docs__search', {}, PERMISSION_CTX)).resolves.toMatchObject({
            behavior: 'deny',
            message: expect.stringMatching(/not marked readonly/),
        });
    });

    it('denies unrecognized MCP-prefixed tool names in live safety modes', async () => {
        const { canUseTool } = bridge({ mcpServerNames: ['docs'] });

        await expect(canUseTool('mcp__unknown__search', {}, PERMISSION_CTX)).resolves.toMatchObject({
            behavior: 'deny',
            message: expect.stringMatching(/unrecognized Claude SDK MCP tool name/),
        });
    });

    it('keeps mock mode permissive for MCP calls', async () => {
        const { canUseTool } = bridge({
            mcpSafety: { runMode: 'mock' },
            mcpServerNames: ['docs'],
        });
        const input = { query: 'mock' };

        await expect(canUseTool('mcp__unknown__search', input, PERMISSION_CTX)).resolves.toEqual({
            behavior: 'allow',
            updatedInput: input,
        });
    });

    it('records canonical redacted MCP evidence when policy denies a Claude MCP call', async () => {
        const deniedMcpEvents = createClaudeDeniedMcpEventStore();
        const { canUseTool } = bridge({
            deniedMcpEvents,
            mcpSafety: {
                runMode: 'live-sandbox',
                liveOptIn: true,
                mcpToolPolicy: { deny: [{ serverName: 'docs', toolName: 'delete' }] },
            },
        });

        await expect(canUseTool(
            'mcp__docs__delete',
            { id: '123', api_key: 'sk-test' },
            { ...PERMISSION_CTX, toolUseID: 'toolu-denied' },
        )).resolves.toMatchObject({ behavior: 'deny' });

        const calls = findMcpToolCalls(deniedMcpEvents.all(), {
            serverName: 'docs',
            toolName: 'delete',
            status: 'policy_denied',
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].arguments).toMatchObject({
            id: '123',
            api_key: '<redacted>',
            server: 'docs',
            tool: 'delete',
            status: 'policy_denied',
            policyResult: {
                action: 'deny',
                reason: 'denylisted',
            },
        });
    });
});
