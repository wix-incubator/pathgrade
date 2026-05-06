import { describe, it, expect, beforeEach } from 'vitest';
import { runConversation, type ConversationDeps } from '../src/sdk/converse.js';
import type { AgentTurnResult } from '../src/types.js';
import type { Message } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';
import { createVerboseEmitter, type VerboseSink } from '../src/reporters/verbose-emitter.js';

function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function createFakeSink(): VerboseSink & { lines: string[] } {
    const lines: string[] = [];
    return { lines, write(l: string) { lines.push(l); } };
}

function makeDeps(overrides: Partial<ConversationDeps> = {}): ConversationDeps {
    return {
        sendTurn: async () => 'default response',
        hasFile: async () => false,
        workspace: '/tmp/test',
        messages: [] as Message[],
        log: [] as LogEntry[],
        ...overrides,
    };
}

function scriptedSender(responses: Array<string | AgentTurnResult | Error>) {
    let i = 0;
    return async (_message: string) => {
        if (i >= responses.length) throw new Error('No more scripted responses');
        const r = responses[i++];
        if (r instanceof Error) throw r;
        return r;
    };
}

describe('runConversation verbose wiring', () => {
    beforeEach(() => {
        delete process.env.PATHGRADE_VERBOSE;
    });

    it('is a no-op with a disabled emitter', async () => {
        const sink = createFakeSink();
        const verbose = createVerboseEmitter({ enabled: false, sink });

        await runConversation(
            { firstMessage: 'Start', maxTurns: 1, until: () => true },
            makeDeps({ sendTurn: scriptedSender(['ok']), verbose }),
        );

        expect(sink.lines).toEqual([]);
    });

    it('emits conversationEnd when until completes', async () => {
        const sink = createFakeSink();
        const verbose = createVerboseEmitter({ enabled: true, sink });

        await runConversation(
            { firstMessage: 'Start', maxTurns: 1, until: () => true },
            makeDeps({ sendTurn: scriptedSender(['ok']), verbose }),
        );

        const stripped = sink.lines.map(stripAnsi);
        const end = stripped.find((l) => l.startsWith('■ end'));
        expect(end).toMatch(/^■ end  reason=until  turns=1  /);
    });

    it('emits reactionFired when a reaction matches', async () => {
        const sink = createFakeSink();
        const verbose = createVerboseEmitter({ enabled: true, sink });

        await runConversation(
            {
                firstMessage: 'Start',
                maxTurns: 2,
                reactions: [{ when: /confirm/, reply: 'Yes confirmed' }],
            },
            makeDeps({ sendTurn: scriptedSender(['please confirm', 'done']), verbose }),
        );

        const stripped = sink.lines.map(stripAnsi);
        const fired = stripped.find((l) => l.startsWith('  ⚡ reaction'));
        expect(fired).toBeDefined();
        expect(fired).toMatch(/^  ⚡ reaction #0 \/confirm\/ → "Yes confirmed"$/);
    });

    it('emits retry when sendTurn throws once and succeeds on retry', async () => {
        const sink = createFakeSink();
        const verbose = createVerboseEmitter({ enabled: true, sink });

        await runConversation(
            { firstMessage: 'Start', maxTurns: 1, until: () => true },
            makeDeps({
                sendTurn: scriptedSender([new Error('transient blip'), 'recovered']),
                verbose,
            }),
        );

        const stripped = sink.lines.map(stripAnsi);
        const retry = stripped.find((l) => l.startsWith('  ⟲ retry'));
        expect(retry).toBeDefined();
        expect(retry).toContain('transient blip');
    });

    it('emits tool events for a turn', async () => {
        const sink = createFakeSink();
        const verbose = createVerboseEmitter({ enabled: true, sink });
        const turnResult: AgentTurnResult = {
            rawOutput: 'working',
            assistantMessage: 'working',
            visibleAssistantMessage: 'working',
            visibleAssistantMessageSource: 'assistant_message',
            exitCode: 0,
            toolEvents: [
                { action: 'read_file', provider: 'claude', providerToolName: 'Read', summary: 'a.ts', confidence: 'high', rawSnippet: '' },
            ],
        };

        await runConversation(
            { firstMessage: 'Start', maxTurns: 1, until: () => true },
            makeDeps({ sendTurn: scriptedSender([turnResult]), verbose }),
        );

        const stripped = sink.lines.map(stripAnsi);
        const toolLine = stripped.find((l) => l.startsWith('  · read_file'));
        expect(toolLine).toBe('  · read_file a.ts');
    });
});
