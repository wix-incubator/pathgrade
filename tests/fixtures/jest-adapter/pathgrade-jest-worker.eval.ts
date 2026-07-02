import { createAgent, evaluate, score } from '@wix/pathgrade';

test('records deterministic Pathgrade evaluation metadata from a Jest worker', async () => {
    const agent = await createAgent({ workspace: process.cwd(), agent: 'codex' });
    const result = await evaluate(agent, [
        score('always scores half', () => 0.5),
    ]);

    expect(result.score).toBe(0.5);
});
