import { describe, expect, it } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { check, evaluate, type Agent } from '@wix/pathgrade';

const lifecycleStateFile = process.env.PATHGRADE_STANDALONE_SMOKE_STATE_FILE;

async function recordLifecycle(event: string): Promise<void> {
    if (!lifecycleStateFile) {
        throw new Error('missing PATHGRADE_STANDALONE_SMOKE_STATE_FILE');
    }
    await appendFile(lifecycleStateFile, `${event}\n`, 'utf8');
}

describe('standalone package', () => {
    it('runs a deterministic Pathgrade evaluation', async () => {
        expect(process.env.PATHGRADE_STANDALONE_ENV_SENTINEL).toBeUndefined();
        const agent: Agent = {
            workspace: process.cwd(),
            log: [],
            messages: [],
            llm: {
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
                call: async () => ({ text: '', provider: 'cli', model: 'fake' }),
            },
            transcript: () => '',
            exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            prompt: async () => { throw new Error('not used by deterministic eval'); },
            runConversation: async () => { throw new Error('not used by deterministic eval'); },
            startChat: async () => { throw new Error('not used by deterministic eval'); },
            dispose: async () => recordLifecycle('agent-disposed'),
        };
        await recordLifecycle('evaluation-started');
        const result = await evaluate(agent, [check('standalone scorer', () => true)]);
        expect(result.score).toBe(1);
        await recordLifecycle('evaluation-scored');
    });
});
