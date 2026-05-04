import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
    probeProtocolFixturePreconditions,
    decideProtocolFixtureRun,
    protocolFixtureSkipMessage,
} from '../src/agents/codex-app-server/fixtures/run-gate.js';
import {
    AppServerClient,
    spawnCodexAppServer,
} from '../src/agents/codex-app-server/fixtures/app-server-client.js';

const decision = decideProtocolFixtureRun(probeProtocolFixturePreconditions());
const suiteFn = decision.shouldRun ? describe : describe.skip;
// Emit a visible skip message so CI logs explain why the suite ran or didn't.
if (!decision.shouldRun) {
    console.warn(protocolFixtureSkipMessage(decision.skipReason ?? 'unknown reason'));
}

suiteFn('codex app-server protocol fixture suite', () => {
    it('scenario 1: thread/start with full required field set accepts and returns matching ThreadStartResponse shape', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-fixture-'));
        const proc = await spawnCodexAppServer();
        const client = new AppServerClient(proc);
        try {
            const response = await client.request('thread/start', {
                cwd,
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
                ephemeral: true,
                experimentalRawEvents: false,
                persistExtendedHistory: false,
            });

            expect(typeof response).toBe('object');
            expect(response).not.toBeNull();
            // Spot-check minimal fields that the vendored `ThreadStartParams`
            // implies the server echoes back. On drift, failure points at
            // `src/agents/codex-app-server/protocol/ThreadStartParams.ts`.
            const body = response as { thread?: { id?: unknown } };
            expect(
                typeof body.thread?.id === 'string',
                `drift: ThreadStartResponse missing thread.id — refresh src/agents/codex-app-server/protocol/ThreadStartParams.ts against codex-rs/app-server-protocol/schema/typescript/v2/`,
            ).toBe(true);
        } finally {
            await client.close();
            await fs.rm(cwd, { recursive: true, force: true });
        }
    });

    it('initialize capabilities include experimentalApi and initialized notification is accepted', async () => {
        const proc = await spawnCodexAppServer();
        const client = new AppServerClient(proc);
        try {
            const response = (await client.request('initialize', {
                clientInfo: { name: 'pathgrade-fixture', version: '0.0.0', title: null },
                capabilities: { experimentalApi: true, optOutNotificationMethods: null },
            })) as Record<string, unknown>;

            expect(typeof response).toBe('object');
            expect(response).not.toBeNull();
            // The server accepts the experimentalApi capability without
            // complaint. On drift (e.g. the capability key renames),
            // this call rejects with a JSON-RPC error and the test fails.

            // Fire the follow-up client notification; it must not be rejected
            // (server may ignore unknown methods silently, but it must not
            // crash the transport).
            client.notify('initialized', null);
            // A trivial round-trip confirms the server still responds after
            // the notification landed.
            const echo = (await client.request('thread/start', {
                cwd: await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-init-')),
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
                ephemeral: true,
                experimentalRawEvents: false,
                persistExtendedHistory: false,
            })) as { thread?: { id?: unknown } };
            expect(typeof echo.thread?.id).toBe('string');
        } finally {
            await client.close();
        }
    });

    // Scenarios 2–6 require a deterministic model-side trigger to make the
    // upstream emit the server-initiated request we want to probe. That
    // infrastructure (a pathgrade-proxied LLM that returns pre-recorded tool
    // calls) lands with slice #6's `CodexAppServerAgent` driver. The tests are
    // declared here with their shapes so the harness is discoverable; they
    // skip individually pending that work.

    it.skip('scenario 2: option-based ToolRequestUserInput round-trip (needs LLM proxy from slice #6)', async () => {});
    it.skip('scenario 3: free-text ToolRequestUserInput round-trip (needs LLM proxy from slice #6)', async () => {});
    it.skip('scenario 4: multi-question ToolRequestUserInput round-trip (needs LLM proxy from slice #6)', async () => {});
    it.skip('scenario 5: declined McpElicitationRequest shape is distinct from ToolRequestUserInput (needs LLM proxy from slice #6)', async () => {});
    it.skip('scenario 6: PermissionsRequestApproval structured response round-trip (needs LLM proxy from slice #6)', async () => {});
});
