import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { Agent, ConversationResult } from '../src/sdk/types.js';
import type { LogEntry } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';

const runConversationMock = vi.fn();

vi.mock('../src/sdk/converse', async () => {
    const actual = await vi.importActual<typeof import('../src/sdk/converse.js')>('../src/sdk/converse');
    return {
        ...actual,
        runConversation: runConversationMock,
    };
});

describe('run snapshot persistence', () => {
    let agent: Agent | undefined;
    let createAgent: typeof import('../src/sdk/index.js').createAgent;
    const pathsToClean: string[] = [];

    beforeEach(async () => {
        vi.resetModules();
        runConversationMock.mockReset();
        ({ createAgent } = await import('../src/sdk/index.js'));
    });

    afterEach(async () => {
        if (agent) {
            await agent.dispose();
            agent = undefined;
        }
        for (const target of pathsToClean) {
            await fs.remove(target).catch(() => {});
        }
        pathsToClean.length = 0;
    });

    it('writes run-snapshot.json next to the debug workspace after runConversation', async () => {
        const debugDir = path.join(os.tmpdir(), `pg-run-snapshot-${Math.random().toString(36).slice(2)}`);
        pathsToClean.push(debugDir);

        const toolEvent: ToolEvent = {
            action: 'run_shell',
            provider: 'codex',
            providerToolName: 'exec_command',
            summary: 'npm test',
            confidence: 'high',
            rawSnippet: 'npm test',
        };

        runConversationMock.mockImplementationOnce(async (_opts, deps): Promise<ConversationResult> => {
            deps.messages.push(
                { role: 'user', content: 'Start replay' },
                { role: 'agent', content: 'Replay ready' },
            );
            deps.log.push(
                {
                    type: 'agent_start',
                    timestamp: '2026-04-07T12:00:00.000Z',
                    instruction: 'Start replay',
                } satisfies LogEntry,
                {
                    type: 'tool_event',
                    timestamp: '2026-04-07T12:00:01.000Z',
                    tool_event: toolEvent,
                } satisfies LogEntry,
                {
                    type: 'agent_result',
                    timestamp: '2026-04-07T12:00:02.000Z',
                    output: 'hidden completion summary',
                    assistant_message: 'Replay ready',
                    assistant_message_source: 'blocked_prompt',
                    raw_assistant_message: 'hidden completion summary',
                    blocked_prompt_index: 0,
                    blocked_prompt_count: 2,
                    blocked_prompt_source_tool: 'AskUserQuestion',
                    blocked_prompt_tool_use_id: 'toolu_replay',
                } satisfies LogEntry,
            );

            return {
                turns: 1,
                completionReason: 'until',
                completionDetail: 'matched replay condition',
                turnTimings: [{ turn: 1, durationMs: 42 }],
                stepResults: [],
            };
        });

        agent = await createAgent({ debug: debugDir });
        await agent!.runConversation({ firstMessage: 'ignored by mock' });
        await fs.writeFile(path.join(agent!.workspace, 'artifact.txt'), 'kept for replay');

        await agent!.dispose();
        agent = undefined;

        const snapshotPath = path.join(debugDir, 'run-snapshot.json');
        expect(await fs.pathExists(snapshotPath)).toBe(true);

        const raw = await fs.readFile(snapshotPath, 'utf-8');
        expect(raw).toContain('\n  "version": 1,');

        const snapshot = await fs.readJSON(snapshotPath);
        expect(snapshot).toMatchObject({
            version: 1,
            agent: expect.any(String),
            messages: [
                { role: 'user', content: 'Start replay' },
                { role: 'agent', content: 'Replay ready' },
            ],
            toolEvents: [toolEvent],
            turnTimings: [{ turn: 1, durationMs: 42 }],
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                completionDetail: 'matched replay condition',
                turnTimings: [{ turn: 1, durationMs: 42 }],
            },
            workspace: debugDir,
        });
        expect(typeof snapshot.timestamp).toBe('string');
        expect(snapshot.log).toHaveLength(3);
        expect(snapshot.log[2]).toMatchObject({
            output: 'hidden completion summary',
            assistant_message: 'Replay ready',
            assistant_message_source: 'blocked_prompt',
            raw_assistant_message: 'hidden completion summary',
            blocked_prompt_source_tool: 'AskUserQuestion',
            blocked_prompt_tool_use_id: 'toolu_replay',
        });
        expect(await fs.readFile(path.join(debugDir, 'artifact.txt'), 'utf-8')).toBe('kept for replay');
    });

    it('does not write a snapshot when debug is enabled but runConversation was never used', async () => {
        const debugDir = path.join(os.tmpdir(), `pg-run-snapshot-empty-${Math.random().toString(36).slice(2)}`);
        pathsToClean.push(debugDir);

        agent = await createAgent({ debug: debugDir });
        await fs.writeFile(path.join(agent!.workspace, 'artifact.txt'), 'workspace only');

        await agent!.dispose();
        agent = undefined;

        expect(await fs.pathExists(path.join(debugDir, 'artifact.txt'))).toBe(true);
        expect(await fs.pathExists(path.join(debugDir, 'run-snapshot.json'))).toBe(false);
        expect(runConversationMock).not.toHaveBeenCalled();
    });
});
