import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import {
  stageMcpConfig,
} from '../src/providers/mcp-config.js';
import type { McpDeclaration } from '../src/providers/mcp-config.js';
import type { MockMcpServerDescriptor } from '../src/core/mcp-mock.types.js';

async function readJsonLine(proc: ChildProcessWithoutNullStreams, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for mock server response')), timeoutMs);
    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter((line) => line.trim());
      for (const line of lines) {
        try {
          clearTimeout(timer);
          proc.stdout.off('data', onData);
          resolve(JSON.parse(line));
          return;
        } catch {}
      }
    };
    proc.stdout.on('data', onData);
  });
}

describe('stageMcpConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-config-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns undefined mcpConfigPath when mcp is undefined', async () => {
    const result = await stageMcpConfig(tmpDir, undefined);
    expect(result.mcpConfigPath).toBeUndefined();
  });

  it('copies configFile to workspace', async () => {
    const srcFile = path.join(tmpDir, 'source-mcp.json');
    await fs.writeJson(srcFile, { mcpServers: { foo: { command: 'echo' } } });

    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const spec: McpDeclaration = { configFile: srcFile };
    const result = await stageMcpConfig(workDir, spec);

    expect(result.mcpConfigPath).toBe('.pathgrade-mcp.json');
    const copied = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    expect(copied).toEqual({ mcpServers: { foo: { command: 'echo' } } });
  });

  it('throws when configFile does not exist', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const spec: McpDeclaration = { configFile: path.join(tmpDir, 'nonexistent.json') };
    await expect(stageMcpConfig(workDir, spec)).rejects.toThrow(/MCP config file not found/);
  });

  it('assembles mcpServers config from mock descriptors', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mock: MockMcpServerDescriptor = {
      __type: 'mock_mcp_server',
      config: {
        name: 'test-server',
        tools: [{ name: 'greet', response: 'hello' }],
      },
    };

    const spec: McpDeclaration = { mock };
    const result = await stageMcpConfig(workDir, spec);

    expect(result.mcpConfigPath).toBe('.pathgrade-mcp.json');

    const mcpConfig = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    expect(mcpConfig.mcpServers).toBeDefined();
    expect(mcpConfig.mcpServers['test-server']).toBeDefined();
    expect(mcpConfig.mcpServers['test-server'].command).toBe('node');
    expect(mcpConfig.mcpServers['test-server'].args).toHaveLength(2);

    // Fixture file should exist
    const fixturePath = path.join(workDir, '.pathgrade-mcp-mock-test-server.json');
    const fixture = await fs.readJson(fixturePath);
    expect(fixture.name).toBe('test-server');
    expect(fixture.tools).toHaveLength(1);
  });

  it('emits a node-runnable mock server script path in source-mode Vitest', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mock: MockMcpServerDescriptor = {
      __type: 'mock_mcp_server',
      config: {
        name: 'path-proof',
        tools: [{ name: 'greet', response: 'hello' }],
      },
    };

    await stageMcpConfig(workDir, { mock });

    const mcpConfig = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    const serverScript = mcpConfig.mcpServers['path-proof'].args[0];
    const fixturePath = mcpConfig.mcpServers['path-proof'].args[1];

    expect(await fs.pathExists(serverScript)).toBe(true);
    expect(serverScript).toBe(path.join(workDir, '.pathgrade-mcp-mock-server.cjs'));

    const proc = spawn('node', [serverScript, fixturePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      const response = await readJsonLine(proc);
      expect(response.result.serverInfo.name).toBe('path-proof');
    } finally {
      proc.kill();
    }
  });

  it('handles multiple mock descriptors', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mocks: MockMcpServerDescriptor[] = [
      {
        __type: 'mock_mcp_server',
        config: { name: 'alpha', tools: [{ name: 't1', response: 1 }] },
      },
      {
        __type: 'mock_mcp_server',
        config: { name: 'beta', tools: [{ name: 't2', response: 2 }] },
      },
    ];

    const spec: McpDeclaration = { mock: mocks };
    const result = await stageMcpConfig(workDir, spec);

    const mcpConfig = await fs.readJson(path.join(workDir, result.mcpConfigPath!));
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['alpha', 'beta']);
  });

  it('throws on duplicate mock server names', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mocks: MockMcpServerDescriptor[] = [
      {
        __type: 'mock_mcp_server',
        config: { name: 'dup', tools: [{ name: 't1', response: 1 }] },
      },
      {
        __type: 'mock_mcp_server',
        config: { name: 'dup', tools: [{ name: 't2', response: 2 }] },
      },
    ];

    const spec: McpDeclaration = { mock: mocks };
    await expect(stageMcpConfig(workDir, spec)).rejects.toThrow(/Duplicate mock MCP server name: "dup"/);
  });

  it('sanitizes server name in fixture filename', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mock: MockMcpServerDescriptor = {
      __type: 'mock_mcp_server',
      config: {
        name: 'my server/v2.0',
        tools: [{ name: 'ping', response: 'pong' }],
      },
    };

    const spec: McpDeclaration = { mock };
    await stageMcpConfig(workDir, spec);

    // "my server/v2.0" should become "my-server-v2-0"
    const sanitizedFixture = path.join(workDir, '.pathgrade-mcp-mock-my-server-v2-0.json');
    expect(await fs.pathExists(sanitizedFixture)).toBe(true);

    // The mcpServers key should still use the original name
    const mcpConfig = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    expect(mcpConfig.mcpServers['my server/v2.0']).toBeDefined();
  });
});
