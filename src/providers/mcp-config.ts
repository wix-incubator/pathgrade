import fs from 'fs-extra';
import * as path from 'path';
import type { MockMcpServerDescriptor } from '../core/mcp-mock.types.js';

/**
 * Stdio-server shape pathgrade writes to `.pathgrade-mcp.json`. Lines up
 * directly with the SDK's `McpStdioServerConfig` (`sdk.d.ts:1005`) — the
 * optional `type: 'stdio'` discriminator is omitted because the JSON
 * `writeMcpConfig` produces does not include it.
 */
export interface McpStdioEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

/** Object form of MCP server entries the SDK driver passes to `Options.mcpServers`. */
export type McpServersObject = Record<string, McpStdioEntry>;

export type McpSpec =
    | { configFile: string }
    | { mock: MockMcpServerDescriptor | MockMcpServerDescriptor[] };

const MCP_CONFIG_FILENAME = '.pathgrade-mcp.json';

export interface McpConfigResult {
    mcpConfigPath: string | undefined;
}

export async function writeMcpConfig(
    workspacePath: string,
    mcp: McpSpec | undefined,
): Promise<McpConfigResult> {
    if (!mcp) return { mcpConfigPath: undefined };

    const mcpConfigPath = MCP_CONFIG_FILENAME;

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

/**
 * Read the JSON `writeMcpConfig` writes into `<workspace>/.pathgrade-mcp.json`
 * and return the inner `mcpServers` object the Claude SDK driver hands to
 * `Options.mcpServers`. Returns `undefined` when the file is absent (the
 * "no MCP" path through the driver — the fixture didn't declare an `mcp` spec).
 *
 * The on-disk path is preserved because the Cursor agent driver still
 * consumes it via `mcpConfigPath` (`src/agents/cursor.ts`) — Claude moves to
 * the object form, Cursor stays on the file.
 */
export async function loadMcpServersForSdk(
    workspacePath: string,
): Promise<McpServersObject | undefined> {
    const configPath = path.join(workspacePath, MCP_CONFIG_FILENAME);
    if (!(await fs.pathExists(configPath))) return undefined;
    const parsed = (await fs.readJson(configPath)) as { mcpServers?: McpServersObject };
    return parsed.mcpServers;
}
