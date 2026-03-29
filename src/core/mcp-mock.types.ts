export interface MockMcpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;
    response: unknown;
}

export interface MockMcpServerConfig {
    name: string;
    tools: MockMcpTool[];
}

export interface MockMcpServerDescriptor {
    __type: 'mock_mcp_server';
    config: MockMcpServerConfig;
}
