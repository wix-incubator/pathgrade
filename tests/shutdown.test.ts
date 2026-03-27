import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShutdownManager } from '../src/utils/shutdown';

describe('ShutdownManager', () => {
    let manager: ShutdownManager;

    beforeEach(() => {
        manager = new ShutdownManager();
    });

    afterEach(() => {
        manager.uninstall();
    });

    it('tracks and cleans up registered resources', async () => {
        const cleanup1 = vi.fn().mockResolvedValue(undefined);
        const cleanup2 = vi.fn().mockResolvedValue(undefined);

        manager.register(cleanup1);
        manager.register(cleanup2);

        await manager.shutdownAll();

        expect(cleanup1).toHaveBeenCalledOnce();
        expect(cleanup2).toHaveBeenCalledOnce();
    });

    it('unregister removes a cleanup', async () => {
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const id = manager.register(cleanup);
        manager.unregister(id);

        await manager.shutdownAll();
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('shutdownAll tolerates errors in individual cleanups', async () => {
        const cleanup1 = vi.fn().mockRejectedValue(new Error('fail'));
        const cleanup2 = vi.fn().mockResolvedValue(undefined);

        manager.register(cleanup1);
        manager.register(cleanup2);

        // Should not throw
        await manager.shutdownAll();
        expect(cleanup2).toHaveBeenCalledOnce();
    });
});
