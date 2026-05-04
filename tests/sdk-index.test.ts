import { describe, it, expect } from 'vitest';

describe('sdk public exports', () => {
    it('exports EvalScorerError from the public SDK entrypoint', async () => {
        const sdk = await import('../src/sdk/index.js');
        expect(sdk.EvalScorerError).toBeDefined();
    });

    it('exports AskBus helpers and timeout error from the public SDK entrypoint', async () => {
        const sdk = await import('../src/sdk/index.js');
        expect(sdk.createAskBus).toBeTypeOf('function');
        expect(sdk.requireAskBusForLiveBatches).toBeTypeOf('function');
        expect(sdk.AskBusTimeoutError).toBeTypeOf('function');
    });

    it('requireAskBusForLiveBatches throws when askBus is missing', async () => {
        const { requireAskBusForLiveBatches } = await import('../src/sdk/index.js');
        expect(() => requireAskBusForLiveBatches(undefined, 'TestDriver')).toThrow(/TestDriver/);
        expect(() => requireAskBusForLiveBatches({}, 'TestDriver')).toThrow(/askBus/);
    });

    it('requireAskBusForLiveBatches returns the bus when provided', async () => {
        const { requireAskBusForLiveBatches, createAskBus } = await import('../src/sdk/index.js');
        const bus = createAskBus({ askUserTimeoutMs: 100 });
        expect(requireAskBusForLiveBatches({ askBus: bus }, 'TestDriver')).toBe(bus);
    });
});
