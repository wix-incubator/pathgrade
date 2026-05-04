import { describe, expect, it } from 'vitest';
import { ClaudeAgent } from '../src/agents/claude.js';
import { createAskBus } from '../src/sdk/ask-bus/bus.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';

function makeStreamJsonOutput(): string {
    const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', skills: [] }),
        JSON.stringify({
            type: 'result',
            session_id: 'session-1',
            result: '',
            is_error: false,
            usage: { input_tokens: 10, output_tokens: 5 },
            permission_denials: [
                {
                    tool_name: 'AskUserQuestion',
                    tool_use_id: 'tool-use-xyz',
                    tool_input: {
                        questions: [
                            {
                                question: 'Which region?',
                                header: 'Region',
                                options: [
                                    { label: 'us-east-1', description: 'US East' },
                                    { label: 'eu-west-1', description: 'EU West' },
                                ],
                            },
                        ],
                    },
                },
            ],
        }),
    ];
    return lines.join('\n');
}

describe('ClaudeAgent emits AskBatch on AskUserQuestion denial', () => {
    it('emits exactly one AskBatch with source=claude, lifecycle=post-hoc, and eager blockedPrompts intact', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const observed: AskBatch[] = [];
        askBus.onAsk((batch) => {
            observed.push(batch);
        });

        const agent = new ClaudeAgent();
        const runCommand = async () => ({
            stdout: makeStreamJsonOutput(),
            stderr: '',
            exitCode: 0,
        });

        const session = await agent.createSession('/tmp', runCommand, { askBus });
        const result = await session.start({ message: 'hi' });

        // Eager blockedPrompts preserved
        expect(result.blockedPrompts).toHaveLength(1);
        expect(result.blockedPrompts[0].prompt).toBe('Which region?');
        expect(result.blockedPrompts[0].sourceTool).toBe('AskUserQuestion');
        expect(result.blockedPrompts[0].toolUseId).toBe('tool-use-xyz');

        // AskBatch emitted into bus
        expect(observed).toHaveLength(1);
        const batch = observed[0];
        expect(batch.source).toBe('claude');
        expect(batch.lifecycle).toBe('post-hoc');
        expect(batch.sourceTool).toBe('AskUserQuestion');
        expect(batch.toolUseId).toBe('tool-use-xyz');
        expect(batch.batchId).toBe('tool-use-xyz');
        expect(batch.questions).toHaveLength(1);
        expect(batch.questions[0].question).toBe('Which region?');
        expect(batch.questions[0].options).toEqual([
            { label: 'us-east-1', description: 'US East' },
            { label: 'eu-west-1', description: 'EU West' },
        ]);
    });

    it('does NOT emit when askBus is absent (null-object semantics for post-hoc)', async () => {
        const agent = new ClaudeAgent();
        const runCommand = async () => ({
            stdout: makeStreamJsonOutput(),
            stderr: '',
            exitCode: 0,
        });

        const session = await agent.createSession('/tmp', runCommand);
        const result = await session.start({ message: 'hi' });

        // No bus, no emission — but blockedPrompts still populated
        expect(result.blockedPrompts).toHaveLength(1);
    });

    it('does NOT emit when there are no AskUserQuestion denials', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const observed: AskBatch[] = [];
        askBus.onAsk((batch) => observed.push(batch));

        const agent = new ClaudeAgent();
        const runCommand = async () => ({
            stdout: JSON.stringify({
                type: 'result',
                session_id: 'session-1',
                result: 'hello',
                is_error: false,
            }),
            stderr: '',
            exitCode: 0,
        });

        const session = await agent.createSession('/tmp', runCommand, { askBus });
        await session.start({ message: 'hi' });

        expect(observed).toHaveLength(0);
    });

    it('turn numbers increment across start/reply', async () => {
        const askBus = createAskBus({ askUserTimeoutMs: 1000 });
        const observed: AskBatch[] = [];
        askBus.onAsk((batch) => observed.push(batch));

        const agent = new ClaudeAgent();
        const runCommand = async () => ({
            stdout: makeStreamJsonOutput(),
            stderr: '',
            exitCode: 0,
        });

        const session = await agent.createSession('/tmp', runCommand, { askBus });
        await session.start({ message: 'hi' });
        await session.reply({ message: 'again' });

        expect(observed.map((b) => b.turnNumber)).toEqual([1, 2]);
    });
});
