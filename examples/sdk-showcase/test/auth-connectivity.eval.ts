/**
 * Minimal auth connectivity checks.
 *
 * Given: ANTHROPIC_API_KEY is present in process.env.
 *
 * Scenarios:
 *   - with ANTHROPIC_BASE_URL  — agent should use host API key with the proxy
 *   - without ANTHROPIC_BASE_URL — agent should authenticate normally (Keychain or host key)
 *   - with OPENAI_API_KEY in env — should not interfere with Claude auth
 *   - claude agent + codex judge — cross-provider auth (both keys work simultaneously)
 *
 * Run:  npx vitest run --config examples/sdk-showcase/vitest.config.mts auth-connectivity
 */
import { describe, it, expect } from 'vitest';
import { createAgent, evaluate, check, judge } from 'pathgrade';
import type { PathgradeMeta } from 'pathgrade';

/** Re-run when SDK source changes, not just when example files change. */
export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**'],
};

async function runScenario(envOverrides?: Record<string, string>) {
    const agent = await createAgent({
        agent: 'claude',
        timeout: 30,
        env: envOverrides,
    });
    try {
        const response = await agent.prompt('Say "hello". One word only.');
        expect(response.toLowerCase()).toContain('hello');

        const result = await evaluate(agent, [
            check('responded', ({ transcript }) => transcript.length > 0),
            judge('coherent-response', {
                rubric:
                    'The agent was asked to say "hello". ' +
                    'Give 1.0 if the response contains a greeting, 0.0 otherwise.',
            }),
        ]);
        expect(result.score).toBeGreaterThan(0);
    } finally {
        await agent.dispose();
    }
}

describe('auth-connectivity', () => {
    it('with ANTHROPIC_BASE_URL (proxy)', async () => {
        await runScenario({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    });

    it('without ANTHROPIC_BASE_URL (direct)', async () => {
        await runScenario();
    });

    it('with OPENAI_API_KEY in env (no interference)', async () => {
        await runScenario({ OPENAI_API_KEY: 'sk-test-dummy-key' });
    });

    it('claude agent + codex judge (cross-provider)', async () => {
        const agent = await createAgent({
            agent: 'claude',
            timeout: 30,
        });
        // Separate codex agent provides an LLM that can call OpenAI models
        const codexJudge = await createAgent({
            agent: 'codex',
            timeout: 30,
        });
        try {
            const response = await agent.prompt('Say "hello". One word only.');
            expect(response.toLowerCase()).toContain('hello');

            const result = await evaluate(agent, [
                check('responded', ({ transcript }) => transcript.length > 0),
                judge('codex-judge', {
                    model: 'gpt-4o',
                    rubric:
                        'The agent was asked to say "hello". ' +
                        'Give 1.0 if the response contains a greeting, 0.0 otherwise.',
                }),
            ], { llm: codexJudge.llm });
            expect(result.score).toBeGreaterThan(0);
        } finally {
            await agent.dispose();
            await codexJudge.dispose();
        }
    });
});
