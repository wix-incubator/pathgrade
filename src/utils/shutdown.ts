type CleanupFn = () => Promise<void>;

export class ShutdownManager {
    private nextId = 0;
    private cleanups = new Map<number, CleanupFn>();
    private shuttingDown = false;
    private signalHandler: (() => void) | undefined;

    register(cleanup: CleanupFn): number {
        const id = this.nextId++;
        this.cleanups.set(id, cleanup);
        return id;
    }

    unregister(id: number): void {
        this.cleanups.delete(id);
    }

    async shutdownAll(): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        const tasks = [...this.cleanups.values()];
        this.cleanups.clear();

        await Promise.allSettled(tasks.map(fn => fn()));
    }

    install(): void {
        if (this.signalHandler) return;
        this.signalHandler = () => {
            this.shutdownAll().finally(() => process.exit(130));
        };
        process.on('SIGINT', this.signalHandler);
        process.on('SIGTERM', this.signalHandler);
    }

    uninstall(): void {
        if (this.signalHandler) {
            process.removeListener('SIGINT', this.signalHandler);
            process.removeListener('SIGTERM', this.signalHandler);
            this.signalHandler = undefined;
        }
        this.shuttingDown = false;
    }
}

/** Global singleton for the CLI process */
export const shutdown = new ShutdownManager();
