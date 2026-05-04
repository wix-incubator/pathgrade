import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, Interface } from 'readline';

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export async function spawnCodexAppServer(
    binaryPath: string = 'codex',
    extraArgs: string[] = [],
): Promise<ChildProcessWithoutNullStreams> {
    const proc = spawn(binaryPath, ['app-server', ...extraArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
    });
    // Surface spawn errors synchronously.
    return new Promise((resolve, reject) => {
        const onErr = (err: Error) => reject(err);
        proc.once('error', onErr);
        // Give it a microtask to attach before returning.
        setImmediate(() => {
            proc.off('error', onErr);
            resolve(proc);
        });
    });
}

/**
 * Minimal JSON-RPC 2.0 client over a line-delimited stdio child process.
 * Drift detector only — not the production driver. Slice #6 ships the driver
 * that reuses this helper's transport contract.
 */
export class AppServerClient {
    private nextId = 1;
    private pending = new Map<number, (response: JsonRpcResponse) => void>();
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly rl: Interface;
    private closed = false;

    constructor(proc: ChildProcessWithoutNullStreams) {
        this.proc = proc;
        this.rl = createInterface({ input: proc.stdout });
        this.rl.on('line', (line) => this.handleLine(line));
        this.proc.stderr.on('data', () => {
            // Surface stderr to help diagnose drift failures in CI.
        });
    }

    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: JsonRpcResponse;
        try {
            parsed = JSON.parse(trimmed) as JsonRpcResponse;
        } catch {
            return;
        }
        if (typeof parsed.id === 'number') {
            const resolver = this.pending.get(parsed.id);
            if (resolver) {
                this.pending.delete(parsed.id);
                resolver(parsed);
            }
        }
    }

    request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
        if (this.closed) throw new Error('AppServerClient closed');
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`codex app-server request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, (response) => {
                clearTimeout(timer);
                if (response.error) {
                    reject(new Error(
                        `codex app-server '${method}' returned error ${response.error.code}: ${response.error.message}`,
                    ));
                    return;
                }
                resolve(response.result);
            });
            this.proc.stdin.write(`${payload}\n`);
        });
    }

    notify(method: string, params: unknown): void {
        const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.proc.stdin.write(`${payload}\n`);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.rl.close();
        try {
            this.proc.stdin.end();
        } catch {
            // ignore
        }
        const exitPromise = new Promise<void>((resolve) => {
            this.proc.once('exit', () => resolve());
        });
        // Give the process a moment to exit gracefully before killing.
        const killTimer = setTimeout(() => {
            if (!this.proc.killed) this.proc.kill('SIGTERM');
        }, 2_000);
        await exitPromise;
        clearTimeout(killTimer);
    }
}
