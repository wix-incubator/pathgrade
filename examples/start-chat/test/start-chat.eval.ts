/**
 * startChat showcase — demonstrates manual turn-by-turn conversation control.
 *
 * Unlike runConversation (which auto-replies via reactions or a persona),
 * startChat gives the eval full programmatic control: inspect each response,
 * check workspace state, and decide what to say next.
 *
 * Scenario: guide the agent through building a small Node.js project step by
 * step, where each follow-up depends on what the agent actually produced.
 *
 * Run with: npx vitest run --config examples/start-chat/vitest.config.mts
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { check, createAgent, evaluate } from '@wix/pathgrade';
import type { PathgradeMeta } from '@wix/pathgrade';

/** Re-run when SDK source changes, not just when example files change. */
export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**'],
};

describe('startChat showcase', () => {
    it('guides a multi-step task with manual replies', async () => {
        const agent = await createAgent({
            agent: 'claude',
            timeout: 240,
        });

        // --- Turn 1: ask the agent to create a config file ---
        const chat = await agent.startChat(
            'Create a file called config.json with this content: { "appName": "demo", "port": 3000 }. Do not create any other files.',
        );

        expect(chat.turn).toBe(1);
        expect(chat.done).toBe(false);
        expect(chat.lastMessage).toBeTruthy();

        // Wait for the file to actually exist before moving on
        const hasConfig = await chat.hasFile('config.json');
        expect(hasConfig).toBe(true);

        // --- Turn 2: read what was created, ask for a dependent file ---
        await chat.reply(
            'Now read config.json and create an index.js file that imports the config and starts an HTTP server on the configured port. Use require() to load the config. The server should respond with the appName on GET /.',
        );

        expect(chat.turn).toBe(2);
        expect(chat.lastMessage).toBeTruthy();

        // --- Turn 3: ask the agent to add a health-check endpoint ---
        await chat.reply(
            'Add a GET /health endpoint to the same index.js that returns { "status": "ok" } as JSON.',
        );

        expect(chat.turn).toBe(3);

        // End the session explicitly
        chat.end();
        expect(chat.done).toBe(true);

        // Message history should contain all turns (user + agent pairs)
        expect(chat.messages.length).toBe(6); // 3 user + 3 agent
        expect(chat.messages[0].role).toBe('user');
        expect(chat.messages[1].role).toBe('agent');

        // --- Evaluate workspace output ---
        const result = await evaluate(agent, [
            check('config-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'config.json')),
            ),
            check('config-valid', async ({ runCommand }) => {
                const { stdout } = await runCommand('cat config.json');
                try {
                    const cfg = JSON.parse(stdout);
                    return cfg.appName === 'demo' && cfg.port === 3000;
                } catch {
                    return false;
                }
            }),
            check('index-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'index.js')),
            ),
            check('index-requires-config', async ({ runCommand }) => {
                const { stdout } = await runCommand('cat index.js');
                return /require\(.*config/.test(stdout);
            }),
            check('index-has-health-endpoint', async ({ runCommand }) => {
                const { stdout } = await runCommand('cat index.js');
                return /\/health/.test(stdout) && /status/.test(stdout);
            }),
        ]);

        expect(result.score).toBeGreaterThan(0);
    });
});
