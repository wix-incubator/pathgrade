import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { writeMcpConfig, loadMcpServersForSdk } from '../src/providers/mcp-config.js';
import type { McpSpec } from '../src/providers/mcp-config.js';
import type { MockMcpServerDescriptor } from '../src/core/mcp-mock.types.js';

describe('writeMcpConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-config-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns undefined mcpConfigPath when mcp is undefined', async () => {
    const result = await writeMcpConfig(tmpDir, undefined);
    expect(result.mcpConfigPath).toBeUndefined();
  });

  it('copies configFile to workspace', async () => {
    const srcFile = path.join(tmpDir, 'source-mcp.json');
    await fs.writeJson(srcFile, { mcpServers: { foo: { command: 'echo' } } });

    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const spec: McpSpec = { configFile: srcFile };
    const result = await writeMcpConfig(workDir, spec);

    expect(result.mcpConfigPath).toBe('.pathgrade-mcp.json');
    const copied = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    expect(copied).toEqual({ mcpServers: { foo: { command: 'echo' } } });
  });

  it('throws when configFile does not exist', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const spec: McpSpec = { configFile: path.join(tmpDir, 'nonexistent.json') };
    await expect(writeMcpConfig(workDir, spec)).rejects.toThrow(/MCP config file not found/);
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

    const spec: McpSpec = { mock };
    const result = await writeMcpConfig(workDir, spec);

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

    const spec: McpSpec = { mock: mocks };
    const result = await writeMcpConfig(workDir, spec);

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

    const spec: McpSpec = { mock: mocks };
    await expect(writeMcpConfig(workDir, spec)).rejects.toThrow(/Duplicate mock MCP server name: "dup"/);
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

    const spec: McpSpec = { mock };
    await writeMcpConfig(workDir, spec);

    // "my server/v2.0" should become "my-server-v2-0"
    const sanitizedFixture = path.join(workDir, '.pathgrade-mcp-mock-my-server-v2-0.json');
    expect(await fs.pathExists(sanitizedFixture)).toBe(true);

    // The mcpServers key should still use the original name
    const mcpConfig = await fs.readJson(path.join(workDir, '.pathgrade-mcp.json'));
    expect(mcpConfig.mcpServers['my server/v2.0']).toBeDefined();
  });
});

describe('loadMcpServersForSdk', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-loader-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns undefined when the workspace has no MCP config file', async () => {
    // Mirrors the "no MCP" path through the driver: writeMcpConfig was a no-op
    // because the fixture didn't declare an `mcp` spec.
    const result = await loadMcpServersForSdk(tmpDir);
    expect(result).toBeUndefined();
  });

  it('returns the inner mcpServers object from .pathgrade-mcp.json', async () => {
    // Shape parity with what writeMcpConfig writes (`{ mcpServers: { ... } }`).
    // The SDK's `Options.mcpServers: Record<string, McpStdioServerConfig>`
    // accepts this shape directly: `{ command, args }` is the stdio form, and
    // the `type: 'stdio'` discriminator is optional.
    await fs.writeJson(path.join(tmpDir, '.pathgrade-mcp.json'), {
      mcpServers: {
        'mock-greeter': {
          command: 'node',
          args: ['/some/path/server.js', '/some/fixture.json'],
        },
      },
    });

    const result = await loadMcpServersForSdk(tmpDir);
    expect(result).toEqual({
      'mock-greeter': {
        command: 'node',
        args: ['/some/path/server.js', '/some/fixture.json'],
      },
    });
  });

  it('round-trips the file writeMcpConfig writes for mock descriptors', async () => {
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    const mock: MockMcpServerDescriptor = {
      __type: 'mock_mcp_server',
      config: {
        name: 'round-trip',
        tools: [{ name: 'greet', response: 'hi' }],
      },
    };

    await writeMcpConfig(workDir, { mock });
    const result = await loadMcpServersForSdk(workDir);

    expect(result).toBeDefined();
    expect(result!['round-trip']).toBeDefined();
    expect(result!['round-trip'].command).toBe('node');
    expect(Array.isArray(result!['round-trip'].args)).toBe(true);
  });

  it('round-trips a passthrough configFile spec', async () => {
    const srcFile = path.join(tmpDir, 'src-mcp.json');
    await fs.writeJson(srcFile, {
      mcpServers: { foo: { command: 'echo', args: ['ok'] } },
    });
    const workDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workDir);

    await writeMcpConfig(workDir, { configFile: srcFile });
    const result = await loadMcpServersForSdk(workDir);

    expect(result).toEqual({ foo: { command: 'echo', args: ['ok'] } });
  });
});
