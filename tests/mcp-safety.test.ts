import { describe, expect, it } from 'vitest';
import {
    decideMcpToolCall,
    redactMcpSecrets,
    type McpPolicyDenialReason,
    type McpSafetyOptions,
} from '../src/sdk/mcp-safety.js';

describe('MCP live safety policy', () => {
    it('requires explicit live opt-in before allowing live-readonly tool calls', () => {
        const policy: McpSafetyOptions = {
            runMode: 'live-readonly',
            mcpToolPolicy: {
                allow: [{ serverName: 'Docs', toolName: 'search_docs', readonly: true }],
            },
        };

        expect(decideMcpToolCall(policy, {
            serverName: 'Docs',
            toolName: 'search_docs',
            arguments: { query: 'editor' },
        })).toMatchObject({
            action: 'deny',
            reason: 'missing_live_opt_in',
        });
    });

    it('allows only explicitly readonly allowlisted tools in live-readonly mode', () => {
        const policy: McpSafetyOptions = {
            runMode: 'live-readonly',
            liveOptIn: true,
            mcpToolPolicy: {
                allow: [{ serverName: 'Docs', toolName: 'search_docs', readonly: true }],
            },
        };

        expect(decideMcpToolCall(policy, {
            serverName: 'Docs',
            toolName: 'search_docs',
            arguments: { query: 'editor' },
        })).toMatchObject({ action: 'allow' });

        expect(decideMcpToolCall(policy, {
            serverName: 'Docs',
            toolName: 'delete_doc',
            arguments: { id: '123' },
        })).toMatchObject({
            action: 'deny',
            reason: 'not_allowlisted',
        });
    });

    it('lets denylist rules override allowlist rules', () => {
        const policy: McpSafetyOptions = {
            runMode: 'live-readonly',
            liveOptIn: true,
            mcpToolPolicy: {
                allow: [{ serverName: 'Docs', toolName: 'search_docs', readonly: true }],
                deny: [{ serverName: 'Docs', toolName: 'search_docs' }],
            },
        };

        expect(decideMcpToolCall(policy, {
            serverName: 'Docs',
            toolName: 'search_docs',
            arguments: { query: 'editor' },
        })).toMatchObject({
            action: 'deny',
            reason: 'denylisted',
        });
    });

    it('redacts secret-bearing MCP material without changing non-secret arguments', () => {
        expect(redactMcpSecrets({
            query: 'editor',
            authorization: 'Bearer token',
            nested: {
                api_key: 'sk-test',
                page: { limit: 1 },
            },
            headers: {
                'x-api-key': 'secret',
                accept: 'application/json',
            },
        })).toEqual({
            query: 'editor',
            authorization: '<redacted>',
            nested: {
                api_key: '<redacted>',
                page: { limit: 1 },
            },
            headers: {
                'x-api-key': '<redacted>',
                accept: 'application/json',
            },
        });
    });

    it('includes unrecognized Claude MCP tool names in the public denial vocabulary', () => {
        const reason: McpPolicyDenialReason = 'unrecognized_mcp_tool_name';
        expect(reason).toBe('unrecognized_mcp_tool_name');
    });
});
