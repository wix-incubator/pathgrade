type CleanupFn = () => Promise<void>;

let nextId = 0;

export class ShutdownManager {
    private cleanups = new Map<number, CleanupFn>();
    private shuttingDown = false;
    private signalHandler: (() => void) | undefined;

    register(cleanup: CleanupFn): number {
        const id = nextId++;
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
