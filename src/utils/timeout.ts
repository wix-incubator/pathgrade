/**
 * Shared timeout utilities for agent and scorer execution.
 */

/**
 * Run an async function with an AbortSignal that fires after timeoutMs.
 * The signal is passed to `run` so it can propagate cancellation to child processes.
 */
export function withAbortTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            controller.abort();
            reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        run(controller.signal).then(
            (val) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(val);
            },
            (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}
