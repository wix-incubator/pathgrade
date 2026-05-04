import { describe, it, expect, afterEach } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

const tempDirs: string[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  for (const p of procs) { try { p.kill(); } catch {} }
  procs.length = 0;
  for (const d of tempDirs) { try { await fs.remove(d); } catch {} }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `pathgrade-mock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(dir: string, fixture: unknown): Promise<string> {
  await fs.ensureDir(dir);
  const fixturePath = path.join(dir, 'fixture.json');
  await fs.writeJson(fixturePath, fixture);
  return fixturePath;
}

function sendJsonRpc(proc: ChildProcess, method: string, params: unknown = {}, id: number = 1): void {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  proc.stdin!.write(body + '\n');
}

function sendNotification(proc: ChildProcess, method: string, params: unknown = {}): void {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  proc.stdin!.write(body + '\n');
}

async function readResponse(proc: ChildProcess, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for response')), timeoutMs);
    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
            clearTimeout(timer);
            proc.stdout!.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {}
      }
    };
    proc.stdout!.on('data', onData);
  });
}

function spawnMockServer(fixturePath: string): ChildProcess {
  const serverPath = path.resolve(__dirname, '../src/mcp-mock-server.ts');
  const proc = spawn('yarn', ['tsx', serverPath, fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(proc);
  return proc;
}

describe('mcp-mock-server', () => {
  it('responds to initialize with capabilities', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'greet', response: 'hello' }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    const response = await readResponse(proc);

    expect(response.result).toBeDefined();
    expect(response.result.capabilities).toBeDefined();
    expect(response.result.capabilities.tools).toBeDefined();
  });

  it('lists tools from fixture', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [
        { name: 'get_weather', description: 'Get weather', response: { temp: 72 } },
        { name: 'get_time', response: '12:00' },
      ],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/list', {}, 2);
    const response = await readResponse(proc);

    expect(response.result.tools).toHaveLength(2);
    expect(response.result.tools[0].name).toBe('get_weather');
    expect(response.result.tools[0].description).toBe('Get weather');
    expect(response.result.tools[1].name).toBe('get_time');
    expect(response.result.tools[1].inputSchema).toEqual({ type: 'object' });
  });

  it('calls tool and returns response', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'get_weather', response: { temp: 72, conditions: 'sunny' } }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/call', { name: 'get_weather', arguments: { city: 'NYC' } }, 2);
    const response = await readResponse(proc);

    expect(response.result.content).toEqual([
      { type: 'text', text: JSON.stringify({ temp: 72, conditions: 'sunny' }) },
    ]);
  });

  it('matches when pattern against input', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [
        { name: 'read_file', when: 'config\\.json', response: '{"key":"val"}' },
        { name: 'read_file', when: 'package\\.json', response: '{"name":"app"}' },
        { name: 'read_file', response: 'not found' },
      ],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');

    sendJsonRpc(proc, 'tools/call', { name: 'read_file', arguments: { path: 'config.json' } }, 2);
    const r1 = await readResponse(proc);
    expect(r1.result.content[0].text).toBe('{"key":"val"}');

    sendJsonRpc(proc, 'tools/call', { name: 'read_file', arguments: { path: 'unknown.txt' } }, 3);
    const r2 = await readResponse(proc);
    expect(r2.result.content[0].text).toBe('not found');
  });

  it('returns error for unknown tool', async () => {
    const dir = makeTempDir();
    const fixturePath = await writeFixture(dir, {
      name: 'test-server',
      tools: [{ name: 'greet', response: 'hello' }],
    });

    const proc = spawnMockServer(fixturePath);
    sendJsonRpc(proc, 'initialize', { capabilities: {} });
    await readResponse(proc);
    sendNotification(proc, 'notifications/initialized');
    sendJsonRpc(proc, 'tools/call', { name: 'nonexistent', arguments: {} }, 2);
    const response = await readResponse(proc);

    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain('nonexistent');
  });
});
