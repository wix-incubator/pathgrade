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
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        run(controller.signal).then(
            (val) => {
                clearTimeout(timer);
                if (timedOut || controller.signal.aborted) {
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
                    return;
                }
                resolve(val);
            },
            (err) => {
                clearTimeout(timer);
                if (timedOut || controller.signal.aborted) {
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
                    return;
                }
                reject(err);
            }
        );
    });
}
