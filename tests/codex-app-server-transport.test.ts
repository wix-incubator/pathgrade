import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import {
    createAppServerSessionHandle,
    createNdjsonTransport,
    type SessionChildHandle,
} from '../src/agents/codex-app-server/transport.js';

/**
 * Pair of streams simulating a subprocess: what the driver writes is readable
 * via `serverIn`; what the "server" writes is readable by the driver via
 * `driverIn`. Mirrors child_process.stdin/stdout.
 */
function streamPair() {
    const driverOut = new PassThrough();
    const serverOut = new PassThrough();
    return { driverOut, serverOut };
}

function readLine(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk: Buffer | string) => {
            buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                stream.off('data', onData);
                stream.off('error', onError);
                resolve(buf.slice(0, nl));
            }
        };
        const onError = (err: Error) => {
            stream.off('data', onData);
            reject(err);
        };
        stream.on('data', onData);
        stream.on('error', onError);
    });
}

describe('createNdjsonTransport', () => {
    it('sendRequest writes a JSON-RPC request and resolves on matching response', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({
            output: driverOut,
            input: serverOut,
        });

        const resultPromise = transport.sendRequest<{ ok: true }>('method/foo', { x: 1 });
        const line = await readLine(driverOut);
        const parsed = JSON.parse(line);
        expect(parsed).toMatchObject({
            jsonrpc: '2.0',
            method: 'method/foo',
            params: { x: 1 },
        });
        expect(typeof parsed.id).toBe('number');

        serverOut.write(
            JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }) + '\n',
        );
        await expect(resultPromise).resolves.toEqual({ ok: true });

        await transport.close();
    });

    it('sendRequest rejects on matching error response', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const resultPromise = transport.sendRequest('bad/method', null);
        const line = await readLine(driverOut);
        const { id } = JSON.parse(line);
        serverOut.write(
            JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: 'Method not found' },
            }) + '\n',
        );
        await expect(resultPromise).rejects.toThrow(/Method not found/);
        await transport.close();
    });

    it('sendNotification writes no id field', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        transport.sendNotification('initialized', null);
        const line = await readLine(driverOut);
        const parsed = JSON.parse(line);
        expect(parsed.id).toBeUndefined();
        expect(parsed).toMatchObject({ jsonrpc: '2.0', method: 'initialized', params: null });
        await transport.close();
    });

    it('dispatches server-initiated requests to onServerRequest', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });

        const seen: Array<{ method: string; id: number | string; params: unknown }> = [];
        transport.onServerRequest((req) => {
            seen.push({ method: req.method, id: req.id, params: req.params });
        });

        serverOut.write(
            JSON.stringify({
                jsonrpc: '2.0',
                id: 42,
                method: 'item/tool/requestUserInput',
                params: { threadId: 't', turnId: 'u', itemId: 'i', questions: [] },
            }) + '\n',
        );
        // one microtask tick for the readline event to deliver
        await new Promise((r) => setImmediate(r));
        expect(seen).toHaveLength(1);
        expect(seen[0].method).toBe('item/tool/requestUserInput');
        expect(seen[0].id).toBe(42);
        await transport.close();
    });

    it('sendResponse writes a response envelope matching a server-request id', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });

        transport.sendResponse(7, { answers: {} });
        const line = await readLine(driverOut);
        const parsed = JSON.parse(line);
        expect(parsed).toEqual({ jsonrpc: '2.0', id: 7, result: { answers: {} } });
        await transport.close();
    });

    it('sendErrorResponse writes an error envelope', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });

        transport.sendErrorResponse(9, -32601, 'Method not found');
        const line = await readLine(driverOut);
        const parsed = JSON.parse(line);
        expect(parsed).toEqual({
            jsonrpc: '2.0',
            id: 9,
            error: { code: -32601, message: 'Method not found' },
        });
        await transport.close();
    });

    it('dispatches server notifications to onNotification', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });

        const seen: Array<{ method: string; params: unknown }> = [];
        transport.onNotification((n) => seen.push({ method: n.method, params: n.params }));

        serverOut.write(
            JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { turnId: 't' } }) + '\n',
        );
        await new Promise((r) => setImmediate(r));
        expect(seen).toEqual([{ method: 'turn/completed', params: { turnId: 't' } }]);
        await transport.close();
    });

    it('malformed JSON lines are ignored', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const seen: unknown[] = [];
        transport.onNotification((n) => seen.push(n));
        serverOut.write('not json\n');
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', method: 'ok', params: null }) + '\n');
        await new Promise((r) => setImmediate(r));
        expect(seen).toHaveLength(1);
        await transport.close();
    });
});

interface FakeChild extends SessionChildHandle {
    readonly killSignals: NodeJS.Signals[];
    fireExit(): void;
}

function makeFakeChild(opts: {
    alreadyExited?: boolean;
    autoExitOn?: NodeJS.Signals | 'none';
}): FakeChild {
    const kills: NodeJS.Signals[] = [];
    const listeners: Array<() => void> = [];
    let exitCode: number | null = opts.alreadyExited ? 0 : null;
    let signalCode: NodeJS.Signals | null = null;
    const autoExit = opts.autoExitOn ?? 'SIGTERM';

    return {
        get pid() {
            return 1234;
        },
        get exitCode() {
            return exitCode;
        },
        get signalCode() {
            return signalCode;
        },
        get killSignals() {
            return kills;
        },
        kill(signal?: NodeJS.Signals) {
            const s = signal ?? 'SIGTERM';
            kills.push(s);
            if (autoExit !== 'none' && autoExit === s) {
                signalCode = s;
                queueMicrotask(() => {
                    for (const l of listeners.splice(0, listeners.length)) l();
                });
            }
            return true;
        },
        once(event, listener) {
            if (event === 'exit') listeners.push(listener);
        },
        fireExit() {
            exitCode = 0;
            for (const l of listeners.splice(0, listeners.length)) l();
        },
    };
}

describe('AppServerSessionHandle.close()', () => {
    it('closes transport and sends SIGTERM when the child exits promptly', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const closeSpy = vi.spyOn(transport, 'close');
        const child = makeFakeChild({ autoExitOn: 'SIGTERM' });
        const handle = createAppServerSessionHandle({ transport, child });

        await handle.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(child.killSignals).toEqual(['SIGTERM']);
    });

    it('no-ops on the child when it has already exited before close', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const closeSpy = vi.spyOn(transport, 'close');
        const child = makeFakeChild({ alreadyExited: true });
        const handle = createAppServerSessionHandle({ transport, child });

        await handle.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(child.killSignals).toEqual([]);
    });

    it('escalates to SIGKILL when SIGTERM is ignored past the grace period', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const child = makeFakeChild({ autoExitOn: 'none' });
        const handle = createAppServerSessionHandle({
            transport,
            child,
            killGracePeriodMs: 20,
        });

        const closePromise = handle.close();
        // After the grace period the handle should escalate to SIGKILL.
        await new Promise((r) => setTimeout(r, 50));
        expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);

        // Finally let the child exit so handle.close() resolves.
        child.fireExit();
        await closePromise;
    });

    it('is idempotent — second close() is a no-op', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const closeSpy = vi.spyOn(transport, 'close');
        const child = makeFakeChild({ autoExitOn: 'SIGTERM' });
        const handle = createAppServerSessionHandle({ transport, child });

        await handle.close();
        await handle.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(child.killSignals).toEqual(['SIGTERM']);
    });

    it('handles a null child — transport is closed but no signals are sent', async () => {
        const { driverOut, serverOut } = streamPair();
        const transport = createNdjsonTransport({ output: driverOut, input: serverOut });
        const closeSpy = vi.spyOn(transport, 'close');
        const handle = createAppServerSessionHandle({ transport, child: null });

        await handle.close();
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(handle.pid).toBeUndefined();
    });
});
