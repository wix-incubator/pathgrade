/**
 * Hello World (shared agent) — minimal example using a single agent and
 * conversation across multiple assertion blocks.
 *
 * The agent is created once in beforeAll, a conversation is run to completion,
 * and each `it` block validates a different aspect of the result.
 *
 * Run: npx vitest run --config examples/hello-world-shared/vitest.config.mts
 */
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Agent, ConversationResult, PathgradeMeta } from '@wix/pathgrade';
import { check, createAgent, evaluate, score } from '@wix/pathgrade';

/** Standalone example — only re-run when its own files change. */
export const __pathgradeMeta: PathgradeMeta = {
    deps: ['examples/hello-world-shared/**'],
};

describe('hello-world-shared', () => {
    let agent: Agent;
    let conversation: ConversationResult;

    beforeAll(async () => {
        agent = await createAgent({
            agent: 'claude',
            timeout: 120,
        });

        conversation = await agent.runConversation({
            firstMessage:
                'Create a file called hello.txt containing exactly the text "Hello, World!" and nothing else. ' +
                'Do not create any other files.',
            maxTurns: 5,
            until: async ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'hello.txt')),
        });
    });

    it('completes within expected turns', () => {
        expect(conversation.turns).toBeGreaterThanOrEqual(1);
        expect(conversation.turns).toBeLessThanOrEqual(5);
    });

    it('stops because the until condition was met', () => {
        expect(conversation.completionReason).toBe('until');
    });

    it('creates hello.txt with the right content', async () => {
        const result = await evaluate(agent, [
            check('file-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'hello.txt')),
            ),
            check('content-correct', async ({ runCommand }) => {
                const { stdout } = await runCommand('cat hello.txt');
                return stdout.trim() === 'Hello, World!';
            }),
        ]);

        expect(result.score).toBe(1);
    });

    it('used file-write tooling', async () => {
        const result = await evaluate(agent, [
            score('wrote-a-file', ({ toolEvents }) => {
                const writes = toolEvents.filter(
                    (e) => e.action === 'write_file' || e.action === 'edit_file',
                );
                return writes.length > 0 ? 1 : 0;
            }),
        ]);

        expect(result.score).toBe(1);
    });
});
