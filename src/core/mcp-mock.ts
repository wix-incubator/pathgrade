import { MockMcpServerConfig, MockMcpServerDescriptor } from './mcp-mock.types.js';

export type { MockMcpTool, MockMcpServerConfig, MockMcpServerDescriptor } from './mcp-mock.types.js';

export function mockMcpServer(config: MockMcpServerConfig): MockMcpServerDescriptor {
    if (!config.name || typeof config.name !== 'string') {
        throw new Error('mockMcpServer: name must be a non-empty string');
    }
    if (!Array.isArray(config.tools) || config.tools.length === 0) {
        throw new Error('mockMcpServer: must have at least one tool');
    }
    for (let i = 0; i < config.tools.length; i++) {
        const tool = config.tools[i];
        if (!tool.name || typeof tool.name !== 'string') {
            throw new Error(`mockMcpServer: tools[${i}].name must be a non-empty string`);
        }
        if (tool.when !== undefined) {
            try {
                new RegExp(tool.when, 'i');
            } catch (e) {
                throw new Error(`mockMcpServer: tools[${i}].when is not a valid regex: ${(e as Error).message}`);
            }
        }
    }
    return { __type: 'mock_mcp_server', config };
}
