import { check, evaluate, type Agent } from '@wix/pathgrade';
import { test } from '@wix/pathgrade/adapters/node-test';

test('records deterministic Pathgrade metadata through node:test', async () => {
    const result = await evaluate(fakeAgent(), [
        check('always passes', () => true),
    ]);

    if (result.score !== 1) {
        throw new Error(`expected score 1, got ${result.score}`);
    }
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
