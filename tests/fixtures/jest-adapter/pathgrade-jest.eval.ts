import { check, createAgent, evaluate } from '@wix/pathgrade';

test('records deterministic Pathgrade evaluation metadata from a Jest test', async () => {
    const agent = await createAgent({ workspace: process.cwd(), agent: 'codex' });
    const result = await evaluate(agent, [
        check('always passes', () => true),
    ]);

    expect(result.score).toBe(1);
});
