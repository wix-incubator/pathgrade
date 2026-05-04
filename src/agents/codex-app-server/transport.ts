import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';

export type Unsubscribe = () => void;

export interface ServerRequestMessage {
    readonly id: number | string;
    readonly method: string;
    readonly params: unknown;
}

export interface ServerNotificationMessage {
    readonly method: string;
    readonly params: unknown;
}

export interface TransportCloseInfo {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly pid?: number;
}

export interface AppServerTransport {
    sendRequest<T = unknown>(method: string, params: unknown): Promise<T>;
    sendNotification(method: string, params: unknown): void;
    sendResponse(id: number | string, result: unknown): void;
    sendErrorResponse(id: number | string, code: number, message: string): void;
    onServerRequest(handler: (req: ServerRequestMessage) => void): Unsubscribe;
    onNotification(handler: (n: ServerNotificationMessage) => void): Unsubscribe;
    onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe;
    close(): Promise<void>;
    readonly pid?: number;
}

/** Internal factory result — includes a hook for the spawner to signal exit. */
interface NdjsonTransportInternal extends AppServerTransport {
    notifyClose(info: TransportCloseInfo): void;
}

interface JsonRpcEnvelope {
    jsonrpc?: '2.0';
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export interface CreateNdjsonTransportInput {
    /** Stream the driver writes JSON-RPC lines to (e.g. child.stdin). */
    output: Writable;
    /** Stream the driver reads JSON-RPC lines from (e.g. child.stdout). */
    input: Readable;
    /** Optional pid for diagnostics. */
    pid?: number;
}

export function createNdjsonTransport(
    cfg: CreateNdjsonTransportInput,
): AppServerTransport {
    return createNdjsonTransportInternal(cfg);
}

function createNdjsonTransportInternal(
    cfg: CreateNdjsonTransportInput,
): NdjsonTransportInternal {
    const { output, input, pid } = cfg;
    let nextId = 1;
    const pendingRequests = new Map<number | string, (env: JsonRpcEnvelope) => void>();
    const serverRequestHandlers = new Set<(req: ServerRequestMessage) => void>();
    const notificationHandlers = new Set<(n: ServerNotificationMessage) => void>();
    const closeHandlers = new Set<(info: TransportCloseInfo) => void>();
    let closed = false;

    const rl = createInterface({ input });

    rl.on('line', (raw) => {
        const line = raw.trim();
        if (!line) return;
        let parsed: JsonRpcEnvelope;
        try {
            parsed = JSON.parse(line) as JsonRpcEnvelope;
        } catch {
            return;
        }
        // Response to a request we sent.
        if (
            parsed.id !== undefined
            && parsed.id !== null
            && parsed.method === undefined
            && (parsed.result !== undefined || parsed.error !== undefined)
        ) {
            const resolver = pendingRequests.get(parsed.id);
            if (resolver) {
                pendingRequests.delete(parsed.id);
                resolver(parsed);
            }
            return;
        }
        // Server-initiated request.
        if (parsed.method !== undefined && parsed.id !== undefined && parsed.id !== null) {
            const msg: ServerRequestMessage = {
                id: parsed.id,
                method: parsed.method,
                params: parsed.params,
            };
            for (const h of serverRequestHandlers) {
                try {
                    h(msg);
                } catch (err) {
                    console.error('AppServerTransport serverRequest handler threw', err);
                }
            }
            return;
        }
        // Notification.
        if (parsed.method !== undefined) {
            const msg: ServerNotificationMessage = {
                method: parsed.method,
                params: parsed.params,
            };
            for (const h of notificationHandlers) {
                try {
                    h(msg);
                } catch (err) {
                    console.error('AppServerTransport notification handler threw', err);
                }
            }
        }
    });

    const writeLine = (obj: unknown): void => {
        if (closed) return;
        output.write(JSON.stringify(obj) + '\n');
    };

    return {
        sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
            if (closed) return Promise.reject(new Error('AppServerTransport closed'));
            const id = nextId++;
            return new Promise<T>((resolve, reject) => {
                pendingRequests.set(id, (env) => {
                    if (env.error) {
                        reject(
                            new Error(
                                `codex app-server '${method}' failed (${env.error.code}): ${env.error.message}`,
                            ),
                        );
                        return;
                    }
                    resolve(env.result as T);
                });
                writeLine({ jsonrpc: '2.0', id, method, params });
            });
        },
        sendNotification(method, params) {
            writeLine({ jsonrpc: '2.0', method, params });
        },
        sendResponse(id, result) {
            writeLine({ jsonrpc: '2.0', id, result });
        },
        sendErrorResponse(id, code, message) {
            writeLine({ jsonrpc: '2.0', id, error: { code, message } });
        },
        onServerRequest(handler) {
            serverRequestHandlers.add(handler);
            return () => {
                serverRequestHandlers.delete(handler);
            };
        },
        onNotification(handler) {
            notificationHandlers.add(handler);
            return () => {
                notificationHandlers.delete(handler);
            };
        },
        onClose(handler) {
            closeHandlers.add(handler);
            return () => {
                closeHandlers.delete(handler);
            };
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            rl.close();
            pendingRequests.clear();
        },
        notifyClose(info) {
            for (const h of closeHandlers) {
                try {
                    h(info);
                } catch (err) {
                    console.error('AppServerTransport close handler threw', err);
                }
            }
        },
        pid,
    };
}

export interface SpawnAppServerTransportInput {
    binary?: string;
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /**
     * Grace period between SIGTERM and SIGKILL during handle close.
     * Exposed for tests; defaults to 2s for production spawns.
     */
    killGracePeriodMs?: number;
}

/**
 * Minimal child-process surface the session handle needs. Real spawns satisfy
 * this via `ChildProcessWithoutNullStreams`; tests can substitute a fake that
 * controls `kill` and `exit` timing without booting a subprocess.
 */
export interface SessionChildHandle {
    readonly pid?: number;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: 'exit', listener: () => void): void;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
}

/**
 * Lifecycle-aware wrapper around the `codex app-server` subprocess and its
 * NDJSON transport. Centralizes the close-then-kill sequence — SIGTERM, wait,
 * escalate to SIGKILL if the child has not exited — so the rest of the driver
 * does not have to coordinate the two resources.
 */
export interface AppServerSessionHandle {
    readonly transport: AppServerTransport;
    readonly pid: number | undefined;
    close(): Promise<void>;
}

interface CreateAppServerSessionHandleInput {
    transport: AppServerTransport;
    child: SessionChildHandle | null;
    killGracePeriodMs?: number;
}

export function createAppServerSessionHandle(
    input: CreateAppServerSessionHandleInput,
): AppServerSessionHandle {
    const { transport, child } = input;
    const killGrace = input.killGracePeriodMs ?? 2_000;
    let closed = false;

    return {
        transport,
        pid: child?.pid,
        async close(): Promise<void> {
            if (closed) return;
            closed = true;

            // Release the transport first so pending pipe writes are not lost.
            await transport.close();

            if (!child) return;
            if (child.exitCode !== null || child.signalCode !== null) return;

            const exited = new Promise<void>((resolve) => {
                child.once('exit', () => resolve());
            });
            try {
                child.kill('SIGTERM');
            } catch {
                // Already exited or missing permissions; ignore and let the
                // exit listener settle if the kill actually landed.
            }

            const killTimer = setTimeout(() => {
                if (child.exitCode !== null || child.signalCode !== null) return;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Best-effort escalation.
                }
            }, killGrace);
            // Don't keep the Node event loop alive just for the kill timer.
            if (typeof killTimer.unref === 'function') killTimer.unref();

            await exited;
            clearTimeout(killTimer);
        },
    };
}

/**
 * Spawn `codex ... app-server` and wrap its stdio in an NDJSON transport.
 * --config overrides (if any) must appear in `args` before `app-server`,
 * matching spike §1 which pins them to the parent `codex` binary.
 */
export function spawnAppServerTransport(
    cfg: SpawnAppServerTransportInput = {},
): AppServerSessionHandle {
    const binary = cfg.binary ?? 'codex';
    const args = cfg.args ?? [];
    const child: ChildProcessWithoutNullStreams = spawn(binary, [...args, 'app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cfg.env ?? process.env,
        cwd: cfg.cwd,
    });

    // Capture codex stderr so we can surface it on unexpected exits. Without
    // this, a codex auth or connectivity failure just shows up as an empty
    // turn with no explanation — especially painful in CI logs.
    let stderrBuf = '';
    const STDERR_CAP_BYTES = 8_192;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        if (stderrBuf.length >= STDERR_CAP_BYTES) return;
        stderrBuf += chunk;
        if (stderrBuf.length > STDERR_CAP_BYTES) stderrBuf = stderrBuf.slice(0, STDERR_CAP_BYTES);
    });

    const transport = createNdjsonTransportInternal({
        output: child.stdin,
        input: child.stdout,
        pid: child.pid,
    });

    child.on('exit', (exitCode, signal) => {
        if (stderrBuf.trim().length > 0) {
            console.error(
                `[codex app-server pid=${child.pid}] exited with code=${exitCode} signal=${signal}. stderr:\n${stderrBuf}`,
            );
        }
        transport.notifyClose({ exitCode, signal, pid: child.pid });
    });

    return createAppServerSessionHandle({
        transport,
        child,
        ...(cfg.killGracePeriodMs !== undefined ? { killGracePeriodMs: cfg.killGracePeriodMs } : {}),
    });
}
