import fs from 'fs-extra';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
    McpConfigFileEntry,
    McpStdioEntry,
    McpStreamableHttpEntry,
} from './mcp-config.js';
import { readStagedMcpServers } from './mcp-config.js';
import type { McpSafetyOptions } from '../sdk/mcp-safety.js';

export type ClaudeSdkMcpServerEntry =
    | McpStdioEntry
    | { type: 'http'; url: string; headers?: Record<string, string> };

/** Object form of MCP server entries the SDK driver passes to `Options.mcpServers`. */
export type McpServersObject = Record<string, ClaudeSdkMcpServerEntry>;

export type CodexMcpServerEntry =
    | McpStdioEntry
    | {
        url: string;
        http_headers?: Record<string, string>;
        env_http_headers?: Record<string, string>;
        bearer_token_env_var?: string;
        startup_timeout_sec?: number;
        tool_timeout_sec?: number;
    };

export interface CodexAppServerMcpConfig extends Record<string, unknown> {
    mcp_servers: Record<string, unknown>;
}

export interface McpRuntimeMountingOptions {
    workspacePath?: string;
    mcpConfigPath?: string;
}

interface WorkspaceMcpRuntimeMountingOptions extends McpRuntimeMountingOptions {
    workspacePath: string;
    runtimeEnv?: Record<string, string>;
}

interface ClaudeLiveMcpSafetyPreflightOptions extends WorkspaceMcpRuntimeMountingOptions {
    mcpSafety?: McpSafetyOptions;
}

interface UnsupportedLiveMcpSafetyRuntimeOptions extends WorkspaceMcpRuntimeMountingOptions {
    runtimeName: string;
    mcpSafety?: McpSafetyOptions;
}

export interface CursorMcpRuntimeMount {
    approveMcps: boolean;
}

function isStdioEntry(entry: McpConfigFileEntry): entry is McpStdioEntry {
    return typeof (entry as McpStdioEntry).command === 'string';
}

function headersForRemote(entry: McpStreamableHttpEntry): Record<string, string> | undefined {
    return entry.headers ?? entry.http_headers;
}

function compact<T extends Record<string, unknown>>(entry: T): T {
    return Object.fromEntries(
        Object.entries(entry).filter(([, value]) => value !== undefined),
    ) as T;
}

function toClaudeSdkMcpServerEntry(entry: McpConfigFileEntry): ClaudeSdkMcpServerEntry {
    if (isStdioEntry(entry)) return entry;
    return compact({
        type: 'http' as const,
        url: entry.url,
        headers: headersForRemote(entry),
    });
}

function toCodexAppServerMcpServerEntry(entry: McpConfigFileEntry): CodexMcpServerEntry {
    if (isStdioEntry(entry)) return entry;
    return compact({
        url: entry.url,
        http_headers: headersForRemote(entry),
        env_http_headers: entry.env_http_headers,
        bearer_token_env_var: entry.bearer_token_env_var,
        startup_timeout_sec: entry.startup_timeout_sec,
        tool_timeout_sec: entry.tool_timeout_sec,
    });
}

function isLiveMcpSafetyMode(options: McpSafetyOptions | undefined): boolean {
    const runMode = options?.runMode ?? 'mock';
    return runMode === 'live-readonly' || runMode === 'live-sandbox' || runMode === 'live';
}

function describeClaudeIncompatibleFields(
    serverName: string,
    entry: McpConfigFileEntry,
): string[] {
    if (isStdioEntry(entry)) return [];
    const fields: string[] = [];
    if (entry.env_http_headers !== undefined) fields.push('env_http_headers');
    if (entry.bearer_token_env_var !== undefined) fields.push('bearer_token_env_var');
    if (entry.headers !== undefined && entry.http_headers !== undefined) {
        fields.push('headers and http_headers');
    }
    return fields.map((field) => `${serverName}: ${field}`);
}

function formatMcpStartupError(serverName: string, error: unknown, stderr: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const stderrSuffix = stderr.trim() ? `\nstderr:\n${stderr.trim()}` : '';
    return new Error(`MCP server ${serverName} failed to start: ${message}${stderrSuffix}`);
}

async function assertStdioMcpServerStarts(
    workspacePath: string,
    serverName: string,
    entry: McpStdioEntry,
    runtimeEnv: Record<string, string> | undefined,
): Promise<void> {
    const timeoutMs = Math.max(1, entry.startup_timeout_sec ?? 15) * 1000;
    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: {
            ...(runtimeEnv ?? {}),
            ...(entry.env ?? {}),
        },
        cwd: workspacePath,
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    const client = new Client(
        { name: 'pathgrade-stdio-mcp-preflight', version: '0.5.0' },
        { capabilities: {} },
    );

    try {
        await client.connect(transport, { timeout: timeoutMs });
        await client.listTools(undefined, { timeout: timeoutMs });
    } catch (error) {
        throw formatMcpStartupError(serverName, error, stderr);
    } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

export async function assertClaudeLiveMcpSafetyPreflight(
    options: ClaudeLiveMcpSafetyPreflightOptions,
): Promise<void> {
    if (!options.mcpConfigPath || !isLiveMcpSafetyMode(options.mcpSafety)) return;
    const mcpServers = await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    if (!mcpServers) return;

    if (options.mcpSafety?.liveOptIn !== true) {
        throw new Error(
            'Claude live MCP safety requires mcpSafety.liveOptIn: true before MCP runtime mounting.',
        );
    }

    const unsupported = Object.entries(mcpServers).flatMap(([serverName, entry]) =>
        describeClaudeIncompatibleFields(serverName, entry));
    if (unsupported.length > 0) {
        throw new Error(
            `Claude live MCP safety does not support runtime-incompatible MCP config fields: ${unsupported.join('; ')}`,
        );
    }
}

export async function assertUnsupportedLiveMcpSafetyRuntime(
    options: UnsupportedLiveMcpSafetyRuntimeOptions,
): Promise<void> {
    if (!options.mcpConfigPath || !isLiveMcpSafetyMode(options.mcpSafety)) return;
    const mcpServers = await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    if (!mcpServers) return;
    throw new Error(
        `${options.runtimeName} live MCP safety enforcement is not supported. Use mock mode or a runtime that enforces mcpSafety before live MCP mounting.`,
    );
}

export async function assertStdioMcpServersStartForClaudeSdk(
    options: WorkspaceMcpRuntimeMountingOptions,
): Promise<void> {
    const mcpServers = await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    if (!mcpServers) return;
    for (const [name, entry] of Object.entries(mcpServers)) {
        if (!isStdioEntry(entry)) continue;
        await assertStdioMcpServerStarts(options.workspacePath, name, entry, options.runtimeEnv);
    }
}

export async function mountMcpForClaudeSdk(
    options: WorkspaceMcpRuntimeMountingOptions,
): Promise<McpServersObject | undefined> {
    const mcpServers = await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    if (!mcpServers) return undefined;
    return Object.fromEntries(
        Object.entries(mcpServers).map(([name, entry]) => [
            name,
            toClaudeSdkMcpServerEntry(entry),
        ]),
    );
}

export async function mountMcpForCodexAppServer(
    options: WorkspaceMcpRuntimeMountingOptions,
): Promise<CodexAppServerMcpConfig | undefined> {
    const mcpServers = await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    if (!mcpServers) return undefined;
    return {
        mcp_servers: Object.fromEntries(
            Object.entries(mcpServers).map(([name, entry]) => [
                name,
                toCodexAppServerMcpServerEntry(entry),
            ]),
        ),
    };
}

export async function mountMcpForCursor(
    options: WorkspaceMcpRuntimeMountingOptions,
): Promise<CursorMcpRuntimeMount> {
    if (!options.mcpConfigPath) return { approveMcps: false };
    await readStagedMcpServers(options.workspacePath, options.mcpConfigPath);
    const srcMcp = path.join(options.workspacePath, options.mcpConfigPath);
    if (!(await fs.pathExists(srcMcp))) return { approveMcps: false };
    const cursorDir = path.join(options.workspacePath, '.cursor');
    await fs.ensureDir(cursorDir);
    await fs.copy(srcMcp, path.join(cursorDir, 'mcp.json'), { overwrite: true });
    return { approveMcps: true };
}

export async function assertMcpRuntimeMountingSupportedForCodexExec(
    options: McpRuntimeMountingOptions,
): Promise<void> {
    if (!options.mcpConfigPath) return;
    throw new Error(
        'Codex exec does not support MCP Runtime Mounting. Use the codex app-server transport for fixtures that stage MCP config.',
    );
}
