import { describe, expect, it, vi } from 'vitest';
import { withAbortTimeout } from '../src/utils/timeout.js';

describe('withAbortTimeout', () => {
    it('rejects when the timer fires even if the wrapped operation never settles', async () => {
        vi.useFakeTimers();
        let signalSeen: AbortSignal | undefined;
        const promise = withAbortTimeout(
            async (signal) => {
                signalSeen = signal;
                await new Promise(() => {});
                return 'unreachable';
            },
            25,
            'Agent (limit: 0.025s)',
        );

        const rejection = expect(promise).rejects.toThrow('Agent (limit: 0.025s) timed out after 0.025s');
        await vi.advanceTimersByTimeAsync(25);
        await rejection;
        expect(signalSeen?.aborted).toBe(true);
        vi.useRealTimers();
    });
});
