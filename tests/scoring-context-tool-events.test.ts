import { describe, it, expect } from 'vitest';
import type { CheckScorer, ToolUsageScorer, ScorerContext } from '../src/sdk/types.js';
import type { Agent } from '../src/sdk/types.js';
import type { LogEntry, CommandResult } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';
import { evaluate } from '../src/sdk/evaluate.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

function makeAgent(overrides?: { log?: LogEntry[] }): Agent {
    return {
        workspace: '/fake',
        log: overrides?.log ?? [],
        messages: [
            { role: 'user' as const, content: 'test' },
            { role: 'agent' as const, content: 'done' },
        ],
        llm: createMockLLM(),
        transcript: () => 'user: test\nagent: done',
        exec: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

function toolEventEntry(event: ToolEvent): LogEntry {
    return { type: 'tool_event', timestamp: '', tool_event: event };
}

function makeToolEvent(action: ToolEvent['action'], toolName: string): ToolEvent {
    return {
        action,
        provider: 'claude',
        providerToolName: toolName,
        summary: `${action} via ${toolName}`,
        confidence: 'high',
        rawSnippet: '...',
    };
}

describe('ScorerContext.toolEvents', () => {
    it('tool_usage scorer receives tool events via context and scores 1.0', async () => {
        const trial = makeAgent({
            log: [
                toolEventEntry(makeToolEvent('read_file', 'Read')),
                toolEventEntry(makeToolEvent('write_file', 'Write')),
            ],
        });

        const scorer: ToolUsageScorer = {
            type: 'tool_usage',
            name: 'expects-read-and-write',
            weight: 1,
            expectations: [
                { action: 'read_file', min: 1 },
                { action: 'write_file', min: 1 },
            ],
        };

        const result = await evaluate(trial, [scorer]);
        expect(result.score).toBe(1.0);
        expect(result.scorers[0].score).toBe(1.0);
    });

    it('check scorer can access ctx.toolEvents', async () => {
        const trial = makeAgent({
            log: [
                toolEventEntry(makeToolEvent('read_file', 'Read')),
            ],
        });

        const scorer: CheckScorer = {
            type: 'check',
            name: 'has-read-event',
            weight: 1,
            fn: (ctx: ScorerContext) => {
                return ctx.toolEvents.some((e) => e.action === 'read_file');
            },
        };

        const result = await evaluate(trial, [scorer]);
        expect(result.score).toBe(1.0);
        expect(result.scorers[0].details).toBe('passed');
    });

    it('tool_usage scorer with empty log scores 0', async () => {
        const trial = makeAgent({ log: [] });

        const scorer: ToolUsageScorer = {
            type: 'tool_usage',
            name: 'expects-events',
            weight: 1,
            expectations: [
                { action: 'read_file', min: 1 },
            ],
        };

        const result = await evaluate(trial, [scorer]);
        expect(result.score).toBe(0);
        expect(result.scorers[0].details).toContain('No tool events');
    });

    it('check scorer sees empty toolEvents when log has no tool_event entries', async () => {
        const trial = makeAgent({
            log: [
                { type: 'command', timestamp: '', command: 'ls' },
            ],
        });

        const scorer: CheckScorer = {
            type: 'check',
            name: 'no-tool-events',
            weight: 1,
            fn: (ctx: ScorerContext) => {
                return ctx.toolEvents.length === 0;
            },
        };

        const result = await evaluate(trial, [scorer]);
        expect(result.score).toBe(1.0);
    });
});
