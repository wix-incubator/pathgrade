import { check, evaluate, type Agent } from '@wix/pathgrade';
import { describe, expect, it } from 'vitest';

describe('standalone CLI Vitest smoke', () => {
    it('uses the internal mode and ignores target environment files', async () => {
        expect(process.env.PATHGRADE_STANDALONE).toBe('1');
        expect(process.env.PATHGRADE_STANDALONE_ENV_SENTINEL).toBeUndefined();

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
            call: async () => ({ text: '', provider: 'cli', model: 'fake' }),
        },
        transcript: () => '',
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        prompt: async () => { throw new Error('not used'); },
        runConversation: async () => { throw new Error('not used'); },
        startChat: async () => { throw new Error('not used'); },
        dispose: async () => undefined,
    };
}
