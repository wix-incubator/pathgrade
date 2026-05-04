import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import {
    createAppServerSessionHandle,
    createNdjsonTransport,
    type AppServerTransport,
    type SessionChildHandle,
} from '../src/agents/codex-app-server/transport.js';
import { CodexAppServerAgent } from '../src/agents/codex-app-server/agent.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';

/**
 * Minimal transport pair that auto-acks the initialize handshake, enough to
 * drive one trivial turn to completion from within a dispose test.
 */
function createSim(): {
    transport: AppServerTransport;
    awaitRequest: (method: string) => Promise<{ id: number | string }>;
    sendResult: (id: number | string, result: unknown) => void;
    sendNotification: (method: string, params: unknown) => void;
} {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const transport = createNdjsonTransport({
        output: clientToServer,
        input: serverToClient,
    });

    const waiters: Array<{ method: string; resolve: (v: { id: number | string }) => void }> = [];
    const buffered = new Map<string, Array<{ id: number | string }>>();

    let buf = '';
    clientToServer.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
            if (!line) continue;
            let parsed: { id?: number | string; method?: string };
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (parsed.method === 'initialize' && parsed.id !== undefined) {
                serverToClient.write(
                    JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }) + '\n',
                );
                continue;
            }
            if (parsed.method && parsed.id !== undefined) {
                const entry = { id: parsed.id };
                const idx = waiters.findIndex((w) => w.method === parsed.method);
                if (idx >= 0) {
                    waiters.splice(idx, 1)[0].resolve(entry);
                } else {
                    const arr = buffered.get(parsed.method) ?? [];
                    arr.push(entry);
                    buffered.set(parsed.method, arr);
                }
            }
        }
    });

    return {
        transport,
        awaitRequest(method) {
            const arr = buffered.get(method);
            if (arr && arr.length) return Promise.resolve(arr.shift()!);
            return new Promise((resolve) => waiters.push({ method, resolve }));
        },
        sendResult(id, result) {
            serverToClient.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        },
        sendNotification(method, params) {
            serverToClient.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
        },
    };
}

/**
 * Fake child that records kill signals and lets the test control exit timing.
 */
function createFakeChild(opts: { autoExitOn?: NodeJS.Signals | 'none' } = {}): SessionChildHandle & {
    readonly killSignals: NodeJS.Signals[];
    fireExit(): void;
} {
    const listeners: Array<() => void> = [];
    const kills: NodeJS.Signals[] = [];
    const autoExit = opts.autoExitOn ?? 'SIGTERM';
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;

    return {
        get pid() {
            return 4242;
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

describe('CodexAppServerAgent dispose()', () => {
    it('closes transport and signals the child subprocess', async () => {
        const sim = createSim();
        const child = createFakeChild();
        const closeSpy = vi.spyOn(sim.transport, 'close');

        const askBus = createAskBus({ askUserTimeoutMs: 1_000 });
        const agent = new CodexAppServerAgent({
            createTransport: async () =>
                createAppServerSessionHandle({ transport: sim.transport, child }),
        });
        const session = await agent.createSession(
            '/tmp/ws',
            async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            { askBus },
        );

        const turnPromise = session.start({ message: 'hi' });
        const ts = await sim.awaitRequest('thread/start');
        sim.sendResult(ts.id, { thread: { id: 't' } });
        const st = await sim.awaitRequest('turn/start');
        sim.sendResult(st.id, { turnId: 'u' });
        sim.sendNotification('turn/completed', {});
        await turnPromise;

        expect(session.dispose).toBeDefined();
        await session.dispose!();

        expect(closeSpy).toHaveBeenCalled();
        expect(child.killSignals).toContain('SIGTERM');
    });

    it('subsequent start() rejects with a "session disposed" error', async () => {
        const sim = createSim();
        const child = createFakeChild();
        const askBus = createAskBus({ askUserTimeoutMs: 1_000 });
        const agent = new CodexAppServerAgent({
            createTransport: async () =>
                createAppServerSessionHandle({ transport: sim.transport, child }),
        });
        const session = await agent.createSession(
            '/tmp/ws',
            async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            { askBus },
        );

        await session.dispose!();
        await expect(session.start({ message: 'again' })).rejects.toThrow(/session disposed/);
    });

    it('dispose() is idempotent — second call is a no-op', async () => {
        const sim = createSim();
        const child = createFakeChild();
        const closeSpy = vi.spyOn(sim.transport, 'close');
        const askBus = createAskBus({ askUserTimeoutMs: 1_000 });
        const agent = new CodexAppServerAgent({
            createTransport: async () =>
                createAppServerSessionHandle({ transport: sim.transport, child }),
        });
        const session = await agent.createSession(
            '/tmp/ws',
            async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            { askBus },
        );

        // Run one turn so the handle is created; idempotency is about not
        // re-closing it on a second dispose call.
        const turnPromise = session.start({ message: 'hi' });
        const ts = await sim.awaitRequest('thread/start');
        sim.sendResult(ts.id, { thread: { id: 't' } });
        const st = await sim.awaitRequest('turn/start');
        sim.sendResult(st.id, { turnId: 'u' });
        sim.sendNotification('turn/completed', {});
        await turnPromise;

        await session.dispose!();
        await session.dispose!();

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(child.killSignals).toEqual(['SIGTERM']);
    });

    it('is safe to call when no turn was ever started (no transport created)', async () => {
        const factory = vi.fn();
        const askBus = createAskBus({ askUserTimeoutMs: 1_000 });
        const agent = new CodexAppServerAgent({
            createTransport: factory as never,
        });
        const session = await agent.createSession(
            '/tmp/ws',
            async () => ({ stdout: '', stderr: '', exitCode: 0 }),
            { askBus },
        );

        await expect(session.dispose!()).resolves.toBeUndefined();
        expect(factory).not.toHaveBeenCalled();
    });
});
