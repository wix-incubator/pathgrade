import type { McpPolicyDenialReason } from '../../sdk/mcp-safety.js';

export type ClaudeSdkMcpToolNameParseResult =
    | { kind: 'non_mcp' }
    | { kind: 'mcp'; server: string; tool: string }
    | { kind: 'unrecognized'; reason: Extract<McpPolicyDenialReason, 'unrecognized_mcp_tool_name'> };

const MCP_TOOL_PREFIX = 'mcp__';

export function parseClaudeSdkMcpToolName(
    providerToolName: string,
    configuredServerNames: readonly string[],
): ClaudeSdkMcpToolNameParseResult {
    if (!providerToolName.startsWith(MCP_TOOL_PREFIX)) return { kind: 'non_mcp' };

    const body = providerToolName.slice(MCP_TOOL_PREFIX.length);
    const matches = configuredServerNames
        .filter((serverName) => {
            if (serverName.length === 0) return false;
            const toolStart = `${serverName}__`;
            return body.startsWith(toolStart) && body.length > toolStart.length;
        })
        .sort((a, b) => b.length - a.length);

    if (matches.length !== 1) {
        return { kind: 'unrecognized', reason: 'unrecognized_mcp_tool_name' };
    }

    const server = matches[0];
    const tool = body.slice(server.length + 2);
    if (!tool) return { kind: 'unrecognized', reason: 'unrecognized_mcp_tool_name' };
    return { kind: 'mcp', server, tool };
}
