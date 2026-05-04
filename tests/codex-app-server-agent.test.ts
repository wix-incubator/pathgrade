import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import {
    createNdjsonTransport,
    createAppServerSessionHandle,
} from '../src/agents/codex-app-server/transport.js';
import type {
    AppServerTransport,
    TransportCloseInfo,
} from '../src/agents/codex-app-server/transport.js';
import { CodexAppServerAgent } from '../src/agents/codex-app-server/agent.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AgentSessionOptions } from '../src/types.js';

interface ClientRequestCapture {
    id: number | string;
    params: unknown;
}
interface ClientNotificationCapture {
    params: unknown;
}
interface ClientResponseCapture {
    id: number | string;
    result?: unknown;
    error?: { code: number; message: string };
}

interface ServerSim {
    transport: AppServerTransport;
    sendServerRequest: (method: string, params: unknown) => { id: number };
    sendNotification: (method: string, params: unknown) => void;
    awaitRequest: (method: string) => Promise<ClientRequestCapture>;
    awaitNotification: (method: string) => Promise<ClientNotificationCapture>;
    awaitResponseTo: (id: number | string) => Promise<ClientResponseCapture>;
    sendResult: (id: number | string, result: unknown) => void;
    sendError: (id: number | string, code: number, message: string) => void;
    closeFromServer: (info: TransportCloseInfo) => void;
}

function createServerSim(): ServerSim {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const driverTransport = createNdjsonTransport({
        output: clientToServer,
        input: serverToClient,
    });

    let buf = '';
    let nextServerId = 10_000;

    interface PendingMatcher {
        kind: 'request' | 'notification' | 'response';
        key: string | number;
        resolve: (v: unknown) => void;
    }
    const awaiters: PendingMatcher[] = [];
    const bufferedRequests = new Map<string, ClientRequestCapture[]>();
    const bufferedNotifications = new Map<string, ClientNotificationCapture[]>();
    const bufferedResponses = new Map<number | string, ClientResponseCapture>();

    function dispatch(line: string): void {
        let parsed: {
            id?: number | string;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { code: number; message: string };
        };
        try {
            parsed = JSON.parse(line);
        } catch {
            return;
        }
        if (parsed.method === 'initialize' && parsed.id !== undefined) {
            // Capture the initialize params so individual tests can assert on
            // the handshake capability shape.
            const entry: ClientRequestCapture = { id: parsed.id, params: parsed.params };
            const ai = awaiters.findIndex(
                (a) => a.kind === 'request' && a.key === 'initialize',
            );
            if (ai >= 0) awaiters.splice(ai, 1)[0].resolve(entry);
            else {
                if (!bufferedRequests.has('initialize')) bufferedRequests.set('initialize', []);
                bufferedRequests.get('initialize')!.push(entry);
            }
            // Auto-ack so tests that don't await the initialize request still
            // proceed through the handshake.
            serverToClient.write(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: parsed.id,
                    result: {
                        userAgent: 'sim/0.0.0',
                        codexHome: '/tmp/.codex',
                        platformFamily: 'unix',
                        platformOs: 'macos',
                    },
                }) + '\n',
            );
            return;
        }
        if (parsed.method && parsed.id !== undefined) {
            // client→server request
            const entry: ClientRequestCapture = { id: parsed.id, params: parsed.params };
            const ai = awaiters.findIndex(
                (a) => a.kind === 'request' && a.key === parsed.method,
            );
            if (ai >= 0) awaiters.splice(ai, 1)[0].resolve(entry);
            else {
                if (!bufferedRequests.has(parsed.method)) bufferedRequests.set(parsed.method, []);
                bufferedRequests.get(parsed.method)!.push(entry);
            }
            return;
        }
        if (parsed.method) {
            // client→server notification
            const entry: ClientNotificationCapture = { params: parsed.params };
            const ai = awaiters.findIndex(
                (a) => a.kind === 'notification' && a.key === parsed.method,
            );
            if (ai >= 0) awaiters.splice(ai, 1)[0].resolve(entry);
            else {
                if (!bufferedNotifications.has(parsed.method))
                    bufferedNotifications.set(parsed.method, []);
                bufferedNotifications.get(parsed.method)!.push(entry);
            }
            return;
        }
        if (parsed.id !== undefined) {
            // client→server response to a server-initiated request
            const entry: ClientResponseCapture = {
                id: parsed.id,
                ...(parsed.result !== undefined ? { result: parsed.result } : {}),
                ...(parsed.error !== undefined ? { error: parsed.error } : {}),
            };
            const ai = awaiters.findIndex(
                (a) => a.kind === 'response' && a.key === parsed.id,
            );
            if (ai >= 0) awaiters.splice(ai, 1)[0].resolve(entry);
            else bufferedResponses.set(parsed.id, entry);
        }
    }

    clientToServer.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) dispatch(line);
            nl = buf.indexOf('\n');
        }
    });

    return {
        transport: driverTransport,
        sendServerRequest(method, params) {
            const id = nextServerId++;
            serverToClient.write(
                JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
            );
            return { id };
        },
        sendNotification(method, params) {
            serverToClient.write(
                JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
            );
        },
        async awaitRequest(method) {
            const q = bufferedRequests.get(method);
            if (q && q.length > 0) return q.shift()!;
            return new Promise<ClientRequestCapture>((resolve) => {
                awaiters.push({
                    kind: 'request',
                    key: method,
                    resolve: (v) => resolve(v as ClientRequestCapture),
                });
            });
        },
        async awaitNotification(method) {
            const q = bufferedNotifications.get(method);
            if (q && q.length > 0) return q.shift()!;
            return new Promise<ClientNotificationCapture>((resolve) => {
                awaiters.push({
                    kind: 'notification',
                    key: method,
                    resolve: (v) => resolve(v as ClientNotificationCapture),
                });
            });
        },
        async awaitResponseTo(id) {
            const buffered = bufferedResponses.get(id);
            if (buffered) {
                bufferedResponses.delete(id);
                return buffered;
            }
            return new Promise<ClientResponseCapture>((resolve) => {
                awaiters.push({
                    kind: 'response',
                    key: id,
                    resolve: (v) => resolve(v as ClientResponseCapture),
                });
            });
        },
        sendResult(id, result) {
            serverToClient.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        },
        sendError(id, code, message) {
            serverToClient.write(
                JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
            );
        },
        closeFromServer(info) {
            (driverTransport as unknown as {
                notifyClose: (i: TransportCloseInfo) => void;
            }).notifyClose(info);
        },
    };
}

async function withAgent<T>(
    fn: (ctx: {
        sim: ServerSim;
        agent: CodexAppServerAgent;
        options: AgentSessionOptions;
    }) => Promise<T>,
    overrides: {
        model?: string;
        sandboxMode?: 'workspace-write' | 'danger-full-access';
        onPermissionGrant?: (entry: unknown) => void;
    } = {},
): Promise<T> {
    const sim = createServerSim();
    const askBus = createAskBus({ askUserTimeoutMs: 1_000 });
    const agent = new CodexAppServerAgent({
        createTransport: async () => (createAppServerSessionHandle({ transport: sim.transport, child: null })),
        ...(overrides.sandboxMode ? { sandboxMode: overrides.sandboxMode } : {}),
        ...(overrides.onPermissionGrant ? { onPermissionGrant: overrides.onPermissionGrant } : {}),
    });
    const options: AgentSessionOptions = {
        askBus,
        ...(overrides.model ? { model: overrides.model } : {}),
    };
    try {
        return await fn({ sim, agent, options });
    } finally {
        await sim.transport.close();
    }
}

async function runSingleTrivialTurn(
    sim: ServerSim,
    threadId = 'thread-1',
): Promise<void> {
    const nt = await sim.awaitRequest('thread/start');
    sim.sendResult(nt.id, { thread: { id: threadId } });
    const st = await sim.awaitRequest('turn/start');
    sim.sendResult(st.id, { turnId: 'turn-1' });
    sim.sendNotification('turn/completed', { threadId, turnId: 'turn-1' });
}

describe('CodexAppServerAgent — handshake', () => {
    it('initialize opts into experimentalApi and sends initialized notification', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });

            const init = await sim.awaitRequest('initialize');
            expect(init.params).toMatchObject({
                clientInfo: { name: 'pathgrade' },
                capabilities: { experimentalApi: true, optOutNotificationMethods: null },
            });

            const initialized = await sim.awaitNotification('initialized');
            expect(initialized.params).toBeNull();

            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');
            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('fails fast when askBus is missing', async () => {
        const agent = new CodexAppServerAgent({
            createTransport: async () => {
                throw new Error('should not be reached');
            },
        });
        await expect(
            agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                {},
            ),
        ).rejects.toThrow(/askBus/);
    });

    it('sends thread/start with ThreadStartParams on first turn', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hello' });

            const nt = await sim.awaitRequest('thread/start');
            const params = nt.params as Record<string, unknown>;
            expect(params.cwd).toBe('/tmp/ws');
            expect(params.approvalPolicy).toBe('never');
            expect(params.sandbox).toBe('workspace-write');
            expect(params.ephemeral).toBe(true);
            expect(params.experimentalRawEvents).toBe(false);
            expect(params.persistExtendedHistory).toBe(false);
            expect(params.baseInstructions).toBeUndefined();
            expect(params.developerInstructions).toBeUndefined();
            sim.sendResult(nt.id, { thread: { id: 'thread-1' } });

            const st = await sim.awaitRequest('turn/start');
            sim.sendResult(st.id, { turnId: 'turn-1' });
            sim.sendNotification('turn/completed', {});

            const result = await turnPromise;
            expect(result.exitCode).toBe(0);
        });
    });

    it('passes model through to thread/start', async () => {
        await withAgent(
            async ({ sim, agent, options }) => {
                const session = await agent.createSession(
                    '/tmp/ws',
                    async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                    options,
                );
                const turnPromise = session.start({ message: 'hi' });
                const nt = await sim.awaitRequest('thread/start');
                expect((nt.params as { model: string }).model).toBe('gpt-5.3-codex');
                sim.sendResult(nt.id, { thread: { id: 't' } });
                const st = await sim.awaitRequest('turn/start');
                sim.sendResult(st.id, { turnId: 'u' });
                sim.sendNotification('turn/completed', {});
                await turnPromise;
            },
            { model: 'gpt-5.3-codex' },
        );
    });

    it('sandboxMode option toggles to danger-full-access', async () => {
        await withAgent(
            async ({ sim, agent, options }) => {
                const session = await agent.createSession(
                    '/tmp/ws',
                    async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                    options,
                );
                const turnPromise = session.start({ message: 'hi' });
                const nt = await sim.awaitRequest('thread/start');
                expect((nt.params as { sandbox: string }).sandbox).toBe(
                    'danger-full-access',
                );
                sim.sendResult(nt.id, { thread: { id: 't' } });
                const st = await sim.awaitRequest('turn/start');
                sim.sendResult(st.id, { turnId: 'u' });
                sim.sendNotification('turn/completed', {});
                await turnPromise;
            },
            { sandboxMode: 'danger-full-access' },
        );
    });

    it('reuses the thread across start+reply (one newThread)', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );

            const turn1 = session.start({ message: 'one' });
            await runSingleTrivialTurn(sim);
            await turn1;

            const turn2 = session.reply({ message: 'two' });
            const st2 = await sim.awaitRequest('turn/start');
            sim.sendResult(st2.id, { turnId: 'u2' });
            sim.sendNotification('turn/completed', {});
            await turn2;

            const raced = await Promise.race([
                sim.awaitRequest('thread/start').then(() => 'got'),
                new Promise<'none'>((r) => setTimeout(() => r('none'), 10)),
            ]);
            expect(raced).toBe('none');
        });
    });
});

describe('CodexAppServerAgent — server-request dispatcher', () => {
    it('item/tool/requestUserInput → emits AskBatch and replies with ToolRequestUserInputResponse', async () => {
        const sim = createServerSim();
        const askBus = createAskBus({ askUserTimeoutMs: 2_000 });
        askBus.onAsk((batch, respond) => {
            respond({
                answers: batch.questions.map((q) => ({
                    questionId: q.id,
                    values: [`ans-${q.id}`],
                    source: 'reaction' as const,
                })),
            });
        });
        const agent = new CodexAppServerAgent({
            createTransport: async () => (createAppServerSessionHandle({ transport: sim.transport, child: null })),
        });
        try {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                { askBus },
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const askReq = sim.sendServerRequest('item/tool/requestUserInput', {
                threadId: 't',
                turnId: 'u',
                itemId: 'ask-1',
                questions: [
                    {
                        id: 'q1',
                        header: '',
                        question: 'Which?',
                        isOther: false,
                        isSecret: false,
                        options: null,
                    },
                ],
            });

            const resp = await sim.awaitResponseTo(askReq.id);
            expect(resp.result).toEqual({
                answers: { q1: { answers: ['ans-q1'] } },
            });

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            const result = await turnPromise;

            const askEvents = result.toolEvents.filter((e) => e.action === 'ask_user');
            expect(askEvents).toHaveLength(1);
            expect(askEvents[0].arguments).toMatchObject({
                batchId: 'ask-1',
                questions: [
                    { id: 'q1', answer: { values: ['ans-q1'], source: 'reaction' } },
                ],
            });
        } finally {
            await sim.transport.close();
        }
    });

    it('item/permissions/requestApproval → echoes permissions with scope=turn, audit log fires', async () => {
        const auditEntries: Array<Record<string, unknown>> = [];
        await withAgent(
            async ({ sim, agent, options }) => {
                const session = await agent.createSession(
                    '/tmp/ws',
                    async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                    options,
                );
                const turnPromise = session.start({ message: 'hi' });
                const nt = await sim.awaitRequest('thread/start');
                sim.sendResult(nt.id, { thread: { id: 't' } });
                const st = await sim.awaitRequest('turn/start');

                const permissions = { kind: 'file', path: '/tmp/x' };
                const req = sim.sendServerRequest('item/permissions/requestApproval', {
                    threadId: 't',
                    turnId: 'u',
                    itemId: 'perm-1',
                    cwd: '/tmp/ws',
                    reason: 'write',
                    permissions,
                });
                const resp = await sim.awaitResponseTo(req.id);
                expect(resp.result).toMatchObject({
                    permissions,
                    scope: 'turn',
                    strictAutoReview: false,
                });

                expect(auditEntries).toHaveLength(1);
                expect(auditEntries[0]).toMatchObject({
                    type: 'permissions_granted',
                    scope: 'turn',
                    turnNumber: 1,
                    requested: permissions,
                });

                sim.sendResult(st.id, { turnId: 'u' });
                sim.sendNotification('turn/completed', {});
                await turnPromise;
            },
            { onPermissionGrant: (e) => auditEntries.push(e as Record<string, unknown>) },
        );
    });

    it('item/commandExecution/requestApproval → auto-approve with scope=turn', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('item/commandExecution/requestApproval', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect(resp.result).toMatchObject({ decision: 'approved', scope: 'turn' });

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('item/fileChange/requestApproval → auto-approve with scope=turn', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('item/fileChange/requestApproval', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect(resp.result).toMatchObject({ decision: 'approved', scope: 'turn' });

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('item/tool/call → declines', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('item/tool/call', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect((resp.result as { status: string }).status).toBe('declined');

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('mcpServer/elicitation/request → declines with action=decline', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('mcpServer/elicitation/request', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect(resp.result).toEqual({ action: 'decline' });

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('unknown server-request method → error response', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('totally/unknown', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect(resp.error).toMatchObject({ code: -32601 });

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            await turnPromise;
        });
    });

    it('subprocess crash mid-turn surfaces exitCode != 0', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            await sim.awaitRequest('turn/start');
            sim.closeFromServer({ exitCode: 137, signal: null, pid: 42 });
            const result = await turnPromise;
            expect(result.exitCode).toBe(137);
        });
    });

    it('subprocess crash mid-turn populates crashInfo on the AgentTurnResult', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            await sim.awaitRequest('turn/start');
            sim.closeFromServer({ exitCode: 139, signal: 'SIGSEGV', pid: 99 });
            const result = await turnPromise;
            expect(result.crashInfo).toBeDefined();
            expect(result.crashInfo?.pid).toBe(99);
            expect(result.crashInfo?.signal).toBe('SIGSEGV');
            expect(result.crashInfo?.exitCode).toBe(139);
        });
    });

    it('turn/start JSON-RPC error → fails the turn promptly with the server message', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const started = Date.now();
            const turnPromise = session.start({ message: 'hi' });

            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            sim.sendError(st.id, -32602, 'Invalid params: schema drift X');

            const result = await Promise.race([
                turnPromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('turn did not settle in time')), 1_000),
                ),
            ]);
            expect(result.exitCode).toBe(1);
            expect(result.rawOutput).toMatch(/Invalid params: schema drift X/);
            // Fast-fail: turn resolves without waiting for a turn/completed that never comes.
            expect(Date.now() - started).toBeLessThan(800);
        });
    });

    it('account/chatgptAuthTokens/refresh → fails the turn with an auth-pointer message', async () => {
        await withAgent(async ({ sim, agent, options }) => {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                options,
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            await sim.awaitRequest('turn/start');

            const r = sim.sendServerRequest('account/chatgptAuthTokens/refresh', {});
            const resp = await sim.awaitResponseTo(r.id);
            expect(resp.error?.message).toMatch(/OPENAI_API_KEY/);

            const result = await turnPromise;
            expect(result.exitCode).not.toBe(0);
            expect(result.rawOutput).toMatch(/OPENAI_API_KEY/);
        });
    });
});

describe('CodexAppServerAgent — ask_user live buffer is AskBatch-based', () => {
    it('driver never constructs ToolEvent {action:ask_user} directly; projection runs at turn-end', async () => {
        const sim = createServerSim();
        const askBus = createAskBus({ askUserTimeoutMs: 2_000 });
        askBus.onAsk((batch, respond) => {
            respond({
                answers: batch.questions.map((q) => ({
                    questionId: q.id,
                    values: ['x'],
                    source: 'reaction' as const,
                })),
            });
        });
        const agent = new CodexAppServerAgent({
            createTransport: async () => (createAppServerSessionHandle({ transport: sim.transport, child: null })),
        });
        try {
            const session = await agent.createSession(
                '/tmp/ws',
                async () => ({ stdout: '', stderr: '', exitCode: 0 }),
                { askBus },
            );
            const turnPromise = session.start({ message: 'hi' });
            const nt = await sim.awaitRequest('thread/start');
            sim.sendResult(nt.id, { thread: { id: 't' } });
            const st = await sim.awaitRequest('turn/start');

            const a1 = sim.sendServerRequest('item/tool/requestUserInput', {
                threadId: 't',
                turnId: 'u',
                itemId: 'ask-1',
                questions: [
                    { id: 'q1', header: '', question: 'Q1?', isOther: false, isSecret: false, options: null },
                ],
            });
            await sim.awaitResponseTo(a1.id);

            const a2 = sim.sendServerRequest('item/tool/requestUserInput', {
                threadId: 't',
                turnId: 'u',
                itemId: 'ask-2',
                questions: [
                    { id: 'q1', header: '', question: 'Q2?', isOther: false, isSecret: false, options: null },
                ],
            });
            await sim.awaitResponseTo(a2.id);

            sim.sendResult(st.id, { turnId: 'u' });
            sim.sendNotification('turn/completed', {});
            const result = await turnPromise;

            const askEvents = result.toolEvents.filter((e) => e.action === 'ask_user');
            expect(askEvents.map((e) => (e.arguments as { batchId: string }).batchId)).toEqual([
                'ask-1',
                'ask-2',
            ]);

            // Bus snapshot is the single source of truth — confirm it carries both.
            const snap = askBus.snapshot();
            expect(snap.map((s) => s.batchId)).toEqual(['ask-1', 'ask-2']);
        } finally {
            await sim.transport.close();
        }
    });
});

// silence unused-import warning for vi in some test permutations
void vi;
