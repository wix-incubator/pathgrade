import { describe, expect, it } from 'vitest';
import { buildAskBatchFromCodexRequestUserInput } from '../src/sdk/ask-bus/parsers.js';
import type { ToolRequestUserInputParams } from '../src/agents/codex-app-server/protocol/index.js';

function canonicalCodexRequestUserInput(): ToolRequestUserInputParams {
    return {
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
    };
}

describe('buildAskBatchFromCodexRequestUserInput', () => {
    it('produces an AskBatch with lifecycle=live, source=codex-app-server, sourceTool=request_user_input', () => {
        const batch = buildAskBatchFromCodexRequestUserInput(
            canonicalCodexRequestUserInput(),
            1,
        );
        expect(batch.lifecycle).toBe('live');
        expect(batch.source).toBe('codex-app-server');
        expect(batch.sourceTool).toBe('request_user_input');
        expect(batch.turnNumber).toBe(1);
        expect(batch.batchId).toBe('tool-use-abc');
        expect(batch.toolUseId).toBe('tool-use-abc');
        expect(batch.questions).toHaveLength(1);
        expect(batch.questions[0]).toMatchObject({
            id: 'q-0',
            header: 'Region',
            question: 'Which region?',
            isOther: false,
            isSecret: false,
        });
    });
});
