import { describe, expect, it } from 'vitest';
import { parseClaudeSdkMcpToolName } from '../src/agents/claude/mcp-tool-name.js';

describe('parseClaudeSdkMcpToolName', () => {
    it('parses a valid Claude SDK MCP tool name using configured server names', () => {
        expect(parseClaudeSdkMcpToolName(
            'mcp__PathGradeStreamableAlias__lookup_project_fact',
            ['PathGradeStreamableAlias'],
        )).toEqual({
            kind: 'mcp',
            server: 'PathGradeStreamableAlias',
            tool: 'lookup_project_fact',
        });
    });

    it('preserves underscores and double underscores inside server and tool segments', () => {
        expect(parseClaudeSdkMcpToolName(
            'mcp__data__warehouse__search__readonly',
            ['data__warehouse'],
        )).toEqual({
            kind: 'mcp',
            server: 'data__warehouse',
            tool: 'search__readonly',
        });
    });

    it('identifies non-MCP tool names without denying them', () => {
        expect(parseClaudeSdkMcpToolName('Bash', ['Bash'])).toEqual({ kind: 'non_mcp' });
    });

    it('fails closed for unknown, ambiguous, and empty-tool MCP-prefixed names', () => {
        expect(parseClaudeSdkMcpToolName('mcp__unknown__search', ['docs'])).toEqual({
            kind: 'unrecognized',
            reason: 'unrecognized_mcp_tool_name',
        });
        expect(parseClaudeSdkMcpToolName('mcp__docs__search__read', ['docs', 'docs__search'])).toEqual({
            kind: 'unrecognized',
            reason: 'unrecognized_mcp_tool_name',
        });
        expect(parseClaudeSdkMcpToolName('mcp__docs__', ['docs'])).toEqual({
            kind: 'unrecognized',
            reason: 'unrecognized_mcp_tool_name',
        });
    });
});
