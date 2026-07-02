import { check, evaluate, type Agent, type PathgradeMeta } from '@wix/pathgrade';
import { describe, expect, it } from 'vitest';

export const __pathgradeMeta: PathgradeMeta = {
    deps: ['src/selected.ts'],
};

describe('changed selection smoke selected eval', () => {
    it('runs when its dependency changes', async () => {
        const result = await evaluate(fakeAgent(), [
            check('always passes', () => true),
        ]);

        expect(result.score).toBe(1);
    });
});

function fakeAgent(): Agent {
    return {
        workspace: process.cwd(),
        log: [],
        messages: [],
        llm: {
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            call: async () => ({
                text: '',
                provider: 'cli',
                model: 'fake',
            }),
        },
        transcript: () => '',
        exec: async () => ({
            exitCode: 0,
            stdout: '',
            stderr: '',
        }),
        prompt: async () => {
            throw new Error('not used by this deterministic eval');
        },
        runConversation: async () => {
            throw new Error('not used by this deterministic eval');
        },
        startChat: async () => {
            throw new Error('not used by this deterministic eval');
        },
        dispose: async () => undefined,
    };
}
