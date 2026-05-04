import { describe, expect, it } from 'vitest';
import {
    buildAskBatchFromClaudeDenials,
    buildAskBatchFromCodexRequestUserInput,
} from '../src/sdk/ask-bus/parsers.js';
import type { ToolRequestUserInputParams } from '../src/agents/codex-app-server/protocol/index.js';

interface ClaudeDenial {
    tool_name: string;
    tool_use_id?: string;
    tool_input?: Record<string, unknown>;
}

interface CanonicalFixture {
    toClaudeDenials: () => ClaudeDenial[];
    toCodexRequestUserInput: () => ToolRequestUserInputParams;
}

function canonicalAskUserFixture(): CanonicalFixture {
    return {
        toClaudeDenials: () => [
            {
                tool_name: 'AskUserQuestion',
                tool_use_id: 'tool-use-abc',
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
        toCodexRequestUserInput: () => ({
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'tool-use-abc',
            questions: [
                {
                    id: 'q-0',
                    header: 'Region',
                    question: 'Which region?',
                    isOther: false,
                    isSecret: false,
                    options: [
                        { label: 'us-east-1', description: 'US East' },
                        { label: 'eu-west-1', description: 'EU West' },
                    ],
                },
            ],
        }),
    };
}

describe('buildAskBatchFromClaudeDenials', () => {
    it('produces an AskBatch with lifecycle=post-hoc, source=claude, sourceTool=AskUserQuestion', () => {
        const fixture = canonicalAskUserFixture();
        const batch = buildAskBatchFromClaudeDenials(fixture.toClaudeDenials(), 3);
        expect(batch.lifecycle).toBe('post-hoc');
        expect(batch.source).toBe('claude');
        expect(batch.sourceTool).toBe('AskUserQuestion');
        expect(batch.turnNumber).toBe(3);
        expect(batch.toolUseId).toBe('tool-use-abc');
        expect(batch.batchId).toBe('tool-use-abc');
        expect(batch.questions).toHaveLength(1);
    });

    it('synthesizes batchId from turnNumber when no toolUseId', () => {
        const batch = buildAskBatchFromClaudeDenials(
            [
                {
                    tool_name: 'AskUserQuestion',
                    tool_input: {
                        questions: [{ question: 'Why?' }],
                    },
                },
            ],
            5,
        );
        expect(batch.toolUseId).toBeUndefined();
        expect(batch.batchId).toMatch(/^claude-post-hoc-turn-5/);
    });

    it('produces multiple questions from a single denial with multiple questions', () => {
        const batch = buildAskBatchFromClaudeDenials(
            [
                {
                    tool_name: 'AskUserQuestion',
                    tool_use_id: 't',
                    tool_input: {
                        questions: [
                            { question: 'a' },
                            { question: 'b' },
                        ],
                    },
                },
            ],
            1,
        );
        expect(batch.questions.map((q) => q.question)).toEqual(['a', 'b']);
        expect(batch.questions.map((q) => q.id)).toEqual(['q-0', 'q-1']);
    });

    it('skips denials for non-AskUserQuestion tools', () => {
        const batch = buildAskBatchFromClaudeDenials(
            [
                { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'rm -rf' } },
                { tool_name: 'AskUserQuestion', tool_use_id: 't', tool_input: { questions: [{ question: 'hi' }] } },
            ],
            2,
        );
        expect(batch.questions).toHaveLength(1);
        expect(batch.questions[0].question).toBe('hi');
    });

    it('defaults isOther/isSecret to false and options=null when no options provided', () => {
        const batch = buildAskBatchFromClaudeDenials(
            [{ tool_name: 'AskUserQuestion', tool_use_id: 't', tool_input: { questions: [{ question: 'q' }] } }],
            1,
        );
        expect(batch.questions[0].isOther).toBe(false);
        expect(batch.questions[0].isSecret).toBe(false);
        expect(batch.questions[0].options).toBeNull();
    });
});

describe('buildAskBatchFromCodexRequestUserInput', () => {
    it('produces an AskBatch with lifecycle=live, source=codex-app-server, sourceTool=request_user_input', () => {
        const fixture = canonicalAskUserFixture();
        const batch = buildAskBatchFromCodexRequestUserInput(
            fixture.toCodexRequestUserInput(),
            1,
        );
        expect(batch.lifecycle).toBe('live');
        expect(batch.source).toBe('codex-app-server');
        expect(batch.sourceTool).toBe('request_user_input');
        expect(batch.turnNumber).toBe(1);
        expect(batch.batchId).toBe('tool-use-abc');
        expect(batch.toolUseId).toBe('tool-use-abc');
    });
});

describe('adapter parity', () => {
    it('Claude and Codex parsers produce field-identical questions[] for semantically-equivalent input', () => {
        const fixture = canonicalAskUserFixture();
        const claudeBatch = buildAskBatchFromClaudeDenials(fixture.toClaudeDenials(), 1);
        const codexBatch = buildAskBatchFromCodexRequestUserInput(
            fixture.toCodexRequestUserInput(),
            1,
        );

        expect(claudeBatch.questions).toEqual(codexBatch.questions);
        expect(claudeBatch.source).toBe('claude');
        expect(codexBatch.source).toBe('codex-app-server');
        expect(claudeBatch.lifecycle).toBe('post-hoc');
        expect(codexBatch.lifecycle).toBe('live');
    });
});
