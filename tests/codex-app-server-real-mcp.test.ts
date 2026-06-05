import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { mountMcpForCodexAppServer } from '../src/providers/mcp-runtime-mounting.js';

const runRealMcpE2e = process.env.PATHGRADE_RUN_REAL_MCP_E2E === '1';
const suite = runRealMcpE2e ? describe : describe.skip;

interface JsonRpcMessage {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message: string };
}

suite('Codex app-server real MCP mounting', () => {
    const tempDirs: string[] = [];
    const children: ChildProcessWithoutNullStreams[] = [];

    afterEach(async () => {
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
            }
        }
        for (const dir of tempDirs.splice(0)) {
            await fs.remove(dir);
        }
    });

    it('mounts a staged MCP config and calls a real MCP tool', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-real-mcp-'));
        tempDirs.push(root);
        const workspace = path.join(root, 'workspace');
        const codexHome = path.join(root, 'codex-home');
        await fs.ensureDir(workspace);
        await fs.ensureDir(codexHome);
        const serverScript = await writeDocsMcpServer(root);
        await fs.writeJson(path.join(workspace, '.pathgrade-mcp.json'), {
            mcpServers: {
                DocsSearch: {
                    command: process.execPath,
                    args: [serverScript],
                },
            },
        });

        const mcpConfig = await mountMcpForCodexAppServer({ workspacePath: workspace });
        const client = startAppServer({ cwd: workspace, codexHome });
        children.push(client.child);

        await client.request('initialize', {
            clientInfo: { name: 'pathgrade-real-mcp-e2e', version: '0', title: null },
            capabilities: { experimentalApi: true, optOutNotificationMethods: null },
        });
        client.notify('initialized', null);

        const started = await client.request<{ thread: { id: string } }>('thread/start', {
            cwd: workspace,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            ephemeral: true,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            model: process.env.PATHGRADE_REAL_CODEX_MODEL ?? 'gpt-5.4',
            config: mcpConfig,
        });

        const startup = await client.waitForNotification(
            (n) =>
                n.method === 'mcpServer/startupStatus/updated'
                && n.params?.name === 'DocsSearch'
                && (n.params.status === 'ready' || n.params.status === 'failed'),
            'DocsSearch startup',
        );

        expect(startup.params).toMatchObject({
            name: 'DocsSearch',
            status: 'ready',
            error: null,
        });

        const toolResult = await client.request<{ content: Array<{ text?: string }> }>(
            'mcpServer/tool/call',
            {
                threadId: started.thread.id,
                server: 'DocsSearch',
                tool: 'search_docs',
                arguments: { query: 'editor', page: { limit: 1 } },
                meta: { source: 'pathgrade-real-mcp-e2e' },
            },
        );

        expect(toolResult.content[0]?.text).toContain('"success": true');
        expect(toolResult.content[0]?.text).toContain('"results"');
    }, 60_000);
});

async function writeDocsMcpServer(root: string): Promise<string> {
    const script = path.join(root, 'docs-mcp-server.mjs');
    await fs.writeFile(script, `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'docs-search-fixture', version: '0.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'search_docs',
          description: 'Search public documentation fixture content',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        }],
      },
    });
    return;
  }
  if (request.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ success: true, results: [{ title: 'Editor guide' }] }) }],
      },
    });
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
});
`);
    return script;
}

function startAppServer(opts: {
    cwd: string;
    codexHome: string;
}): {
    child: ChildProcessWithoutNullStreams;
    request<T = unknown>(method: string, params: unknown): Promise<T>;
    notify(method: string, params: unknown): void;
    waitForNotification(
        predicate: (n: JsonRpcMessage) => boolean,
        label: string,
    ): Promise<JsonRpcMessage>;
} {
    const child = spawn('codex', ['app-server'], {
        cwd: opts.cwd,
        env: {
            ...process.env,
            CODEX_HOME: opts.codexHome,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'dummy',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let nextId = 1;
    let stderr = '';
    let stdoutBuffer = '';
    const pending = new Map<number | string, (msg: JsonRpcMessage) => void>();
    const notifications: JsonRpcMessage[] = [];

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line) dispatchLine(line);
            newline = stdoutBuffer.indexOf('\n');
        }
    });

    function dispatchLine(line: string): void {
        let msg: JsonRpcMessage;
        try {
            msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
            return;
        }
        if (msg.id !== undefined && msg.method === undefined) {
            const resolve = pending.get(msg.id);
            if (resolve) {
                pending.delete(msg.id);
                resolve(msg);
            }
            return;
        }
        if (msg.method) notifications.push(msg);
    }

    return {
        child,
        request<T>(method: string, params: unknown): Promise<T> {
            const id = nextId++;
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`timed out waiting for ${method}; stderr=${stderr}`));
                }, 45_000);
                pending.set(id, (msg) => {
                    clearTimeout(timer);
                    if (msg.error) reject(new Error(`${method} failed: ${msg.error.message}`));
                    else resolve(msg.result as T);
                });
            });
        },
        notify(method: string, params: unknown): void {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        },
        async waitForNotification(
            predicate: (n: JsonRpcMessage) => boolean,
            label: string,
        ): Promise<JsonRpcMessage> {
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline) {
                const index = notifications.findIndex(predicate);
                if (index >= 0) return notifications.splice(index, 1)[0];
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`timed out waiting for ${label}; stderr=${stderr}`);
        },
    };
}
