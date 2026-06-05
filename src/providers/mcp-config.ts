import fs from 'fs-extra';
import * as path from 'path';
import type { MockMcpServerDescriptor } from '../core/mcp-mock.types.js';

/**
 * Stdio-server shape pathgrade writes to `.pathgrade-mcp.json`. Lines up
 * directly with the SDK's `McpStdioServerConfig` (`sdk.d.ts:1005`) — the
 * optional `type: 'stdio'` discriminator is omitted because the JSON
 * `stageMcpConfig` produces does not include it.
 */
export interface McpStdioEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    startup_timeout_sec?: number;
    tool_timeout_sec?: number;
}

export interface McpStreamableHttpEntry {
    type?: 'streamable-http' | 'http';
    url: string;
    headers?: Record<string, string>;
    http_headers?: Record<string, string>;
    env_http_headers?: Record<string, string>;
    bearer_token_env_var?: string;
    startup_timeout_sec?: number;
    tool_timeout_sec?: number;
}

export type McpConfigFileEntry = McpStdioEntry | McpStreamableHttpEntry;

export type McpDeclaration =
    | { configFile: string }
    | { mock: MockMcpServerDescriptor | MockMcpServerDescriptor[] };

export const MCP_CONFIG_FILENAME = '.pathgrade-mcp.json';
const GENERATED_MOCK_SERVER_FILENAME = '.pathgrade-mcp-mock-server.cjs';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value)
        && Object.values(value).every((entry) => typeof entry === 'string');
}

function assertOptionalStringRecord(
    serverName: string,
    fieldName: string,
    value: unknown,
): void {
    if (value !== undefined && !isStringRecord(value)) {
        throw new Error(`Invalid MCP server "${serverName}": ${fieldName} must be a string record`);
    }
}

function assertOptionalStringArray(
    serverName: string,
    fieldName: string,
    value: unknown,
): void {
    if (value !== undefined && (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))) {
        throw new Error(`Invalid MCP server "${serverName}": ${fieldName} must be a string array`);
    }
}

function assertOptionalNumber(
    serverName: string,
    fieldName: string,
    value: unknown,
): void {
    if (value !== undefined && typeof value !== 'number') {
        throw new Error(`Invalid MCP server "${serverName}": ${fieldName} must be a number`);
    }
}

function validateMcpConfigFileEntry(
    serverName: string,
    entry: unknown,
): McpConfigFileEntry {
    if (!isRecord(entry)) {
        throw new Error(`Invalid MCP server "${serverName}": entry must be an object`);
    }

    const hasCommand = entry.command !== undefined;
    const hasUrl = entry.url !== undefined;

    if (hasCommand && hasUrl) {
        throw new Error(`Invalid MCP server "${serverName}": must not define both command and url`);
    }

    if (hasCommand) {
        if (typeof entry.command !== 'string') {
            throw new Error(`Invalid MCP server "${serverName}": command must be a string`);
        }
        assertOptionalStringArray(serverName, 'args', entry.args);
        assertOptionalStringRecord(serverName, 'env', entry.env);
        assertOptionalNumber(serverName, 'startup_timeout_sec', entry.startup_timeout_sec);
        assertOptionalNumber(serverName, 'tool_timeout_sec', entry.tool_timeout_sec);
        return entry as unknown as McpStdioEntry;
    }

    if (!hasUrl) {
        throw new Error(`Invalid MCP server "${serverName}": expected command or url`);
    }

    if (entry.type !== undefined && entry.type !== 'streamable-http' && entry.type !== 'http') {
        throw new Error(`Unsupported MCP server type for "${serverName}": ${String(entry.type)}`);
    }
    if (typeof entry.url !== 'string') {
        throw new Error(`Invalid MCP server "${serverName}": url must be a string`);
    }
    assertOptionalStringRecord(serverName, 'headers', entry.headers);
    assertOptionalStringRecord(serverName, 'http_headers', entry.http_headers);
    assertOptionalStringRecord(serverName, 'env_http_headers', entry.env_http_headers);
    if (entry.bearer_token_env_var !== undefined && typeof entry.bearer_token_env_var !== 'string') {
        throw new Error(`Invalid MCP server "${serverName}": bearer_token_env_var must be a string`);
    }
    assertOptionalNumber(serverName, 'startup_timeout_sec', entry.startup_timeout_sec);
    assertOptionalNumber(serverName, 'tool_timeout_sec', entry.tool_timeout_sec);
    return entry as unknown as McpStreamableHttpEntry;
}

function readMcpServers(parsed: unknown): Record<string, McpConfigFileEntry> | undefined {
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return undefined;
    return Object.fromEntries(
        Object.entries(parsed.mcpServers).map(([name, entry]) => [
            name,
            validateMcpConfigFileEntry(name, entry),
        ]),
    );
}

export async function readStagedMcpServers(
    workspacePath: string,
    mcpConfigPath: string = MCP_CONFIG_FILENAME,
): Promise<Record<string, McpConfigFileEntry> | undefined> {
    const configPath = path.join(workspacePath, mcpConfigPath);
    if (!(await fs.pathExists(configPath))) return undefined;
    return readMcpServers(await fs.readJson(configPath));
}

export function missingMcpSecretReferences(
    mcpServers: Record<string, McpConfigFileEntry> | undefined,
    env: Record<string, string | undefined>,
): string[] {
    if (!mcpServers) return [];
    const missing: string[] = [];
    for (const [serverName, entry] of Object.entries(mcpServers)) {
        if ('env_http_headers' in entry) {
            for (const envVar of Object.values(entry.env_http_headers ?? {})) {
                if (!env[envVar]) missing.push(`${serverName}: env_http_headers references ${envVar}`);
            }
        }
        if ('bearer_token_env_var' in entry && entry.bearer_token_env_var && !env[entry.bearer_token_env_var]) {
            missing.push(`${serverName}: bearer_token_env_var references ${entry.bearer_token_env_var}`);
        }
    }
    return missing;
}

export async function assertMcpSecretReferencesReady(opts: {
    workspacePath: string;
    mcpConfigPath?: string;
    env: Record<string, string | undefined>;
}): Promise<void> {
    const mcpServers = await readStagedMcpServers(opts.workspacePath, opts.mcpConfigPath);
    const missing = missingMcpSecretReferences(mcpServers, opts.env);
    if (missing.length > 0) {
        throw new Error(`Missing MCP secret references: ${missing.join('; ')}`);
    }
}

async function resolveMockServerScript(workspacePath: string): Promise<string> {
    const compiledScript = path.resolve(import.meta.dirname, '../mcp-mock-server.js');
    if (await fs.pathExists(compiledScript)) return compiledScript;

    const sourceScript = path.resolve(import.meta.dirname, '../mcp-mock-server.ts');
    if (!await fs.pathExists(sourceScript)) {
        throw new Error(`Mock MCP server source not found: ${sourceScript}`);
    }

    const ts = await import('typescript');
    const source = await fs.readFile(sourceScript, 'utf-8');
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
        },
        fileName: sourceScript,
    });
    const generatedScript = path.join(workspacePath, GENERATED_MOCK_SERVER_FILENAME);
    await fs.writeFile(
        generatedScript,
        [
            '// Generated by PathGrade from src/mcp-mock-server.ts.',
            '// This trial-local file lets external agent runtimes spawn the mock server with plain node.',
            transpiled.outputText,
        ].join('\n'),
    );
    return generatedScript;
}

export interface McpConfigResult {
    mcpConfigPath: string | undefined;
}

export async function stageMcpConfig(
    workspacePath: string,
    mcp: McpDeclaration | undefined,
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

        const mockServerScript = await resolveMockServerScript(workspacePath);
        const mcpServers: Record<string, { command: string; args: string[] }> = {};
        for (const mock of mocks) {
            const sanitizedName = mock.config.name.replace(/[^a-zA-Z0-9-]/g, '-');
            const fixturePath = path.join(workspacePath, `.pathgrade-mcp-mock-${sanitizedName}.json`);
            await fs.writeJson(fixturePath, mock.config, { spaces: 2 });

            mcpServers[mock.config.name] = {
                command: 'node',
                args: [mockServerScript, fixturePath],
            };
        }
        await fs.writeJson(path.join(workspacePath, mcpConfigPath), { mcpServers }, { spaces: 2 });
    }

    return { mcpConfigPath };
}
