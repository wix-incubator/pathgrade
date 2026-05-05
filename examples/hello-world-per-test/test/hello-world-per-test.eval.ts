/**
 * Hello World (per-test agent) — minimal example where each test creates its
 * own agent and conversation from scratch.
 *
 * This is the simplest possible pattern: one `it` block = one agent = one task.
 *
 * Run: npx vitest run --config examples/hello-world-per-test/vitest.config.mts
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { check, createAgent, evaluate } from '@wix/pathgrade';
import type { PathgradeMeta } from '@wix/pathgrade';

/** Standalone example — only re-run when its own files change. */
export const __pathgradeMeta: PathgradeMeta = {
    deps: ['examples/hello-world-per-test/**'],
};

describe('hello-world-per-test', () => {
    it('creates a greeting file', async () => {
        const agent = await createAgent({
            agent: 'claude',
            timeout: 120,
        });

        await agent.runConversation({
            firstMessage: 'Create a file called greeting.txt containing "Hi there!" and nothing else.',
            maxTurns: 3,
            until: async ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'greeting.txt')),
        });

        const result = await evaluate(agent, [
            check('file-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'greeting.txt')),
            ),
            check('content-correct', async ({ runCommand }) => {
                const { stdout } = await runCommand('cat greeting.txt');
                return stdout.trim() === 'Hi there!';
            }),
        ]);

        expect(result.score).toBe(1);
    });

    it('answers a simple prompt', async () => {
        const agent = await createAgent({
            agent: 'claude',
            timeout: 60,
        });

        const response = await agent.prompt('What is 2 + 2? Reply with just the number, nothing else.');

        expect(response).toContain('4');
    });
});
