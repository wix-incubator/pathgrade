import { describe, expect, it } from 'vitest';
import type { Agent, ToolEvent } from '../src/sdk/index.js';
import type { CommandResult, LogEntry } from '../src/types.js';
import {
    check,
    evaluate,
    findMcpToolCalls,
    getMcpStartupStatus,
    getMcpToolCall,
    isMcpStartupStatus,
    isMcpToolCall,
} from '../src/sdk/index.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

function toolEventEntry(event: ToolEvent): LogEntry {
    return { type: 'tool_event', timestamp: '', tool_event: event };
}

function makeAgent(toolEvents: ToolEvent[]): Agent {
    return {
        workspace: '/fake',
        log: toolEvents.map(toolEventEntry),
        messages: [
            { role: 'user', content: 'test' },
            { role: 'agent', content: 'done' },
        ],
        llm: createMockLLM(),
        transcript: () => 'user: test\nagent: done',
        exec: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until', turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

function makeMcpToolEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
    return {
        action: 'mcp_tool_call',
        provider: 'codex',
        providerToolName: 'DocsSearch.search_docs',
        arguments: {
            server: 'DocsSearch',
            tool: 'search_docs',
            status: 'completed',
            query: 'editor',
        },
        summary: 'MCP tool DocsSearch.search_docs completed',
        confidence: 'high',
        rawSnippet: '{}',
        ...overrides,
    };
}

describe('MCP Evidence helpers', () => {
    it('lets check scorers assert an MCP tool call through the public SDK helper', async () => {
        const result = await evaluate(makeAgent([makeMcpToolEvent()]), [
            check('used docs search', ({ toolEvents }) =>
                toolEvents.some((event) => isMcpToolCall(event, {
                    serverName: 'DocsSearch',
                    toolName: 'search_docs',
                    status: 'completed',
                    argumentsContaining: { query: 'editor' },
                })),
            ),
        ]);

        expect(result.score).toBe(1);
        expect(result.scorers[0].details).toBe('passed');
    });

    it('projects canonical MCP call evidence from Claude and Codex event shapes', () => {
        const claudeCall = getMcpToolCall(makeMcpToolEvent({
            provider: 'claude',
            providerToolName: 'PathGradeStreamableAlias.lookup_project_fact',
            arguments: {
                topic: 'streamable-http',
                server: 'PathGradeStreamableAlias',
                tool: 'lookup_project_fact',
                status: 'completed',
            },
        }));
        const codexCall = getMcpToolCall(makeMcpToolEvent({
            provider: 'codex',
            providerToolName: 'DocsSearch.search_docs',
            arguments: {
                server: 'DocsSearch',
                tool: 'search_docs',
                status: 'completed',
                query: 'editor',
                page: { limit: 1 },
            },
        }));

        expect(claudeCall).toMatchObject({
            serverName: 'PathGradeStreamableAlias',
            toolName: 'lookup_project_fact',
            status: 'completed',
            arguments: { topic: 'streamable-http' },
        });
        expect(codexCall).toMatchObject({
            serverName: 'DocsSearch',
            toolName: 'search_docs',
            status: 'completed',
            arguments: { query: 'editor', page: { limit: 1 } },
        });
        expect(isMcpToolCall(codexCall!.event, {
            serverName: 'DocsSearch',
            toolName: 'search_docs',
            argumentsContaining: { page: { limit: 1 } },
        })).toBe(true);
    });

    it('selects startup-ready and startup-failed evidence without exposing raw provider internals', () => {
        const ready: ToolEvent = {
            action: 'unknown',
            provider: 'codex',
            providerToolName: 'mcpServer/startupStatus/updated',
            arguments: { name: 'DocsSearch', status: 'ready' },
            summary: 'MCP server DocsSearch startup ready',
            confidence: 'high',
            rawSnippet: '{}',
        };
        const failed: ToolEvent = {
            ...ready,
            arguments: {
                name: 'PathGradeMockScenario',
                status: 'failed',
                error: 'authentication missing',
            },
            summary: 'MCP server PathGradeMockScenario startup failed',
        };

        expect(isMcpStartupStatus(ready, {
            serverName: 'DocsSearch',
            status: 'ready',
        })).toBe(true);
        expect(getMcpStartupStatus(failed)).toMatchObject({
            serverName: 'PathGradeMockScenario',
            status: 'failed',
            error: 'authentication missing',
        });
    });

    it('keeps future MCP tool statuses matchable for the Safety spike', () => {
        expect(isMcpToolCall(makeMcpToolEvent({
            arguments: {
                server: 'DocsSearch',
                tool: 'search_docs',
                status: 'policy_denied',
                query: 'restricted',
            },
        }), {
            serverName: 'DocsSearch',
            toolName: 'search_docs',
            status: 'policy_denied',
            argumentsContaining: { query: 'restricted' },
        })).toBe(true);
    });

    it('supports order-sensitive workflow assertions with explicit indexes', () => {
        const events = [
            makeMcpToolEvent({
                providerToolName: 'ProjectFacts.lookup_project_fact',
                arguments: {
                    server: 'ProjectFacts',
                    tool: 'lookup_project_fact',
                    status: 'completed',
                    topic: 'product',
                },
            }),
            makeMcpToolEvent({
                providerToolName: 'DocsSearch.search_docs',
                arguments: {
                    server: 'DocsSearch',
                    tool: 'search_docs',
                    status: 'completed',
                    query: 'smart cart',
                },
            }),
        ];

        const calls = findMcpToolCalls(events, { status: 'completed' });
        expect(calls.map((call) => [call.serverName, call.toolName])).toEqual([
            ['ProjectFacts', 'lookup_project_fact'],
            ['DocsSearch', 'search_docs'],
        ]);
        expect(calls[0].arguments.topic).toBe('product');
        expect(calls[1].arguments.query).toBe('smart cart');
    });
});
