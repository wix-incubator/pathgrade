import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
    assertClaudeLiveMcpSafetyPreflight,
    assertMcpRuntimeMountingSupportedForCodexExec,
    assertUnsupportedLiveMcpSafetyRuntime,
    assertStdioMcpServersStartForClaudeSdk,
    mountMcpForClaudeSdk,
    mountMcpForCodexAppServer,
    mountMcpForCursor,
} from '../src/providers/mcp-runtime-mounting.js';
import { assertMcpSecretReferencesReady, stageMcpConfig } from '../src/providers/mcp-config.js';
import type { MockMcpServerDescriptor } from '../src/core/mcp-mock.types.js';
import { CodexAgent } from '../src/agents/codex.js';

describe('MCP Runtime Mounting', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-mcp-runtime-mounting-'));
    });

    afterEach(async () => {
        await fs.remove(workspace);
    });

    it('mounts staged MCP config as Claude SDK mcpServers object form', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: {
                    type: 'streamable-http',
                    url: 'http://127.0.0.1:8123/mcp',
                    headers: { authorization: 'Bearer static-token' },
                },
            },
        });

        await expect(
            mountMcpForClaudeSdk({ workspacePath: workspace, mcpConfigPath: '.pathgrade-mcp.json' }),
        ).resolves.toEqual({
            docs: {
                type: 'http',
                url: 'http://127.0.0.1:8123/mcp',
                headers: { authorization: 'Bearer static-token' },
            },
        });
    });

    it('passes staged stdio entries through for Claude SDK mounting', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                'mock-greeter': {
                    command: 'node',
                    args: ['/some/path/server.js', '/some/fixture.json'],
                },
            },
        });

        await expect(mountMcpForClaudeSdk({ workspacePath: workspace })).resolves.toEqual({
            'mock-greeter': {
                command: 'node',
                args: ['/some/path/server.js', '/some/fixture.json'],
            },
        });
    });

    it('requires Claude live MCP safety opt-in before runtime mounting', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: { url: 'http://127.0.0.1:8123/mcp' },
            },
        });

        await expect(
            assertClaudeLiveMcpSafetyPreflight({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'live-readonly' },
            }),
        ).rejects.toThrow(/Claude.*liveOptIn/);

        await expect(
            assertClaudeLiveMcpSafetyPreflight({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'mock' },
            }),
        ).resolves.toBeUndefined();
    });

    it('rejects Claude-incompatible live MCP config before runtime mounting', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                envHeaders: {
                    url: 'http://127.0.0.1:8123/mcp',
                    env_http_headers: { authorization: 'DOCS_TOKEN' },
                },
                bearer: {
                    url: 'http://127.0.0.1:8124/mcp',
                    bearer_token_env_var: 'DOCS_BEARER',
                },
                both: {
                    url: 'http://127.0.0.1:8125/mcp',
                    headers: { authorization: 'Bearer one' },
                    http_headers: { authorization: 'Bearer two' },
                },
            },
        });

        await expect(
            assertClaudeLiveMcpSafetyPreflight({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'live', liveOptIn: true },
            }),
        ).rejects.toThrow(/Claude.*envHeaders.*env_http_headers.*bearer.*bearer_token_env_var.*both.*headers.*http_headers/s);
    });

    it('allows Claude-compatible explicit live MCP headers', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                headers: {
                    url: 'http://127.0.0.1:8123/mcp',
                    headers: { authorization: 'Bearer one' },
                },
                httpHeaders: {
                    url: 'http://127.0.0.1:8124/mcp',
                    http_headers: { authorization: 'Bearer two' },
                },
            },
        });

        await expect(
            assertClaudeLiveMcpSafetyPreflight({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'live-sandbox', liveOptIn: true },
            }),
        ).resolves.toBeUndefined();
    });

    it('fails Claude SDK stdio MCP preflight with startup stderr when initialize cannot complete', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                'bad-auth': {
                    command: process.execPath,
                    args: ['-e', 'console.error("auth failed for data-platform"); process.exit(1);'],
                    startup_timeout_sec: 1,
                },
            },
        });

        await expect(
            assertStdioMcpServersStartForClaudeSdk({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
            }),
        ).rejects.toThrow(/MCP server bad-auth failed to start[\s\S]*auth failed for data-platform/);
    });

    it('runs Claude SDK stdio MCP preflight with the sandbox runtime env', async () => {
        const sandboxHome = path.join(workspace, 'sandbox-home');
        const serverPath = path.join(workspace, 'env-check-mcp.cjs');
        await fs.writeFile(serverPath, `
const readline = require('node:readline');
if (process.env.HOME !== ${JSON.stringify(sandboxHome)}) {
  console.error('HOME mismatch: ' + process.env.HOME);
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'env-check', version: '1.0.0' },
      },
    }) + '\\n');
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
    }) + '\\n');
  }
});
`);
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                'env-check': {
                    command: process.execPath,
                    args: [serverPath],
                    startup_timeout_sec: 1,
                },
            },
        });

        await expect(
            assertStdioMcpServersStartForClaudeSdk({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                runtimeEnv: { HOME: sandboxHome, PATH: process.env.PATH ?? '' },
            }),
        ).resolves.toBeUndefined();
    });

    it('round-trips staged mock descriptors through Claude SDK mounting', async () => {
        const mock: MockMcpServerDescriptor = {
            __type: 'mock_mcp_server',
            config: {
                name: 'round-trip',
                tools: [{ name: 'greet', response: 'hi' }],
            },
        };

        await stageMcpConfig(workspace, { mock });
        const result = await mountMcpForClaudeSdk({ workspacePath: workspace });

        expect(result).toBeDefined();
        expect(result!['round-trip']).toMatchObject({ command: 'node' });
        expect(Array.isArray((result!['round-trip'] as { args?: unknown }).args)).toBe(true);
    });

    it('mounts staged MCP config as Codex app-server thread/start config', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: {
                    url: 'http://127.0.0.1:8123/mcp',
                    headers: { authorization: 'Bearer preferred' },
                    env_http_headers: { 'x-api-key': 'PATHGRADE_FIXTURE_TOKEN' },
                    bearer_token_env_var: 'PATHGRADE_FIXTURE_BEARER',
                    startup_timeout_sec: 15,
                    tool_timeout_sec: 20,
                },
            },
        });

        await expect(
            mountMcpForCodexAppServer({ workspacePath: workspace, mcpConfigPath: '.pathgrade-mcp.json' }),
        ).resolves.toEqual({
            mcp_servers: {
                docs: {
                    url: 'http://127.0.0.1:8123/mcp',
                    http_headers: { authorization: 'Bearer preferred' },
                    env_http_headers: { 'x-api-key': 'PATHGRADE_FIXTURE_TOKEN' },
                    bearer_token_env_var: 'PATHGRADE_FIXTURE_BEARER',
                    startup_timeout_sec: 15,
                    tool_timeout_sec: 20,
                },
            },
        });
    });

    it('checks referenced remote MCP header secrets before live mounting', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: {
                    url: 'http://127.0.0.1:8123/mcp',
                    env_http_headers: { authorization: 'DOCS_TOKEN' },
                    bearer_token_env_var: 'DOCS_BEARER',
                },
            },
        });

        await expect(assertMcpSecretReferencesReady({
            workspacePath: workspace,
            mcpConfigPath: '.pathgrade-mcp.json',
            env: { DOCS_TOKEN: 'token' },
        })).rejects.toThrow(/DOCS_BEARER/);

        await expect(assertMcpSecretReferencesReady({
            workspacePath: workspace,
            mcpConfigPath: '.pathgrade-mcp.json',
            env: { DOCS_TOKEN: 'token', DOCS_BEARER: 'bearer' },
        })).resolves.toBeUndefined();
    });

    it('materializes staged MCP config for Cursor and requests MCP approval', async () => {
        const stagedConfig = {
            mcpServers: {
                docs: {
                    command: 'node',
                    args: ['server.js'],
                },
            },
        };
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), stagedConfig, { spaces: 2 });

        await expect(
            mountMcpForCursor({ workspacePath: workspace, mcpConfigPath: '.pathgrade-mcp.json' }),
        ).resolves.toEqual({ approveMcps: true });

        await expect(fs.readJson(path.join(workspace, '.cursor', 'mcp.json'))).resolves.toEqual(stagedConfig);
    });

    it('rejects live MCP safety modes for Cursor before runtime mounting', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: { command: 'node', args: ['server.js'] },
            },
        });

        await expect(
            assertUnsupportedLiveMcpSafetyRuntime({
                runtimeName: 'Cursor',
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'live-readonly', liveOptIn: true },
            }),
        ).rejects.toThrow(/Cursor.*live MCP safety enforcement is not supported/);
        await expect(fs.pathExists(path.join(workspace, '.cursor', 'mcp.json'))).resolves.toBe(false);
    });

    it('keeps unsupported-runtime MCP safety guard permissive in mock mode', async () => {
        await expect(
            assertUnsupportedLiveMcpSafetyRuntime({
                runtimeName: 'Cursor',
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
                mcpSafety: { runMode: 'mock' },
            }),
        ).resolves.toBeUndefined();
    });

    it('returns empty adapter payloads without touching runtime files when no MCP config is staged', async () => {
        await expect(mountMcpForClaudeSdk({ workspacePath: workspace })).resolves.toBeUndefined();
        await expect(mountMcpForCodexAppServer({ workspacePath: workspace })).resolves.toBeUndefined();
        await expect(mountMcpForCursor({ workspacePath: workspace })).resolves.toEqual({ approveMcps: false });
        await expect(fs.pathExists(path.join(workspace, '.cursor', 'mcp.json'))).resolves.toBe(false);
    });

    it('rejects malformed staged MCP config before returning an adapter payload', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                bad: {
                    command: 'node',
                    url: 'http://127.0.0.1:8123/mcp',
                },
            },
        });

        await expect(
            mountMcpForCodexAppServer({ workspacePath: workspace, mcpConfigPath: '.pathgrade-mcp.json' }),
        ).rejects.toThrow(/must not define both command and url/);
    });

    it('rejects unsupported staged MCP server types before returning an adapter payload', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: {
                    type: 'sse',
                    url: 'http://127.0.0.1:8123/mcp',
                },
            },
        });

        await expect(
            mountMcpForCodexAppServer({ workspacePath: workspace, mcpConfigPath: '.pathgrade-mcp.json' }),
        ).rejects.toThrow(/Unsupported MCP server type/);
    });

    it('rejects Codex exec runtime mounting when staged MCP config exists', async () => {
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                docs: { command: 'node', args: ['server.js'] },
            },
        });

        await expect(
            assertMcpRuntimeMountingSupportedForCodexExec({
                workspacePath: workspace,
                mcpConfigPath: '.pathgrade-mcp.json',
            }),
        ).rejects.toThrow(/Codex exec does not support MCP Runtime Mounting/);
    });

    it('makes Codex exec fail before starting a turn when mcpConfigPath is present', async () => {
        const agent = new CodexAgent();
        const commands: string[] = [];
        const session = await agent.createSession(
            workspace,
            async (cmd) => {
                commands.push(cmd);
                return { stdout: '', stderr: '', exitCode: 0 };
            },
            { mcpConfigPath: '.pathgrade-mcp.json' },
        );

        await expect(session.start({ message: 'hello' })).rejects.toThrow(
            /Codex exec does not support MCP Runtime Mounting/,
        );
        expect(commands).toEqual([]);
    });
});
