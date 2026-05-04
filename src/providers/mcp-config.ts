import fs from 'fs-extra';
import * as path from 'path';
import type { MockMcpServerDescriptor } from '../core/mcp-mock.types.js';

export type McpSpec =
    | { configFile: string }
    | { mock: MockMcpServerDescriptor | MockMcpServerDescriptor[] };

export interface McpConfigResult {
    mcpConfigPath: string | undefined;
}

export async function writeMcpConfig(
    workspacePath: string,
    mcp: McpSpec | undefined,
): Promise<McpConfigResult> {
    if (!mcp) return { mcpConfigPath: undefined };

    const mcpConfigPath = '.pathgrade-mcp.json';

    if ('configFile' in mcp) {
        const mcpSrc = path.resolve(mcp.configFile);
        if (!await fs.pathExists(mcpSrc)) {
            throw new Error(`MCP config file not found: ${mcpSrc}`);
        }
        await fs.copy(mcpSrc, path.join(workspacePath, mcpConfigPath));
    } else if ('mock' in mcp) {
        const mocks = Array.isArray(mcp.mock) ? mcp.mock : [mcp.mock];
        const seen = new Set<string>();
        for (const mock of mocks) {
            if (seen.has(mock.config.name)) {
                throw new Error(`Duplicate mock MCP server name: "${mock.config.name}"`);
            }
            seen.add(mock.config.name);
        }

        const mcpServers: Record<string, { command: string; args: string[] }> = {};
        for (const mock of mocks) {
            const sanitizedName = mock.config.name.replace(/[^a-zA-Z0-9-]/g, '-');
            const fixturePath = path.join(workspacePath, `.pathgrade-mcp-mock-${sanitizedName}.json`);
            await fs.writeJson(fixturePath, mock.config, { spaces: 2 });

            const mockServerScript = path.resolve(import.meta.dirname, '../mcp-mock-server.js');
            mcpServers[mock.config.name] = {
                command: 'node',
                args: [mockServerScript, fixturePath],
            };
        }
        await fs.writeJson(path.join(workspacePath, mcpConfigPath), { mcpServers }, { spaces: 2 });
    }

    return { mcpConfigPath };
}
