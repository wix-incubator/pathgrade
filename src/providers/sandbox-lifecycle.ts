import fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

export const SANDBOX_PREFIX = 'pathgrade-';
export const SANDBOX_MARKER = '.pathgrade-sandbox.json';
export const STALE_SANDBOX_AGE_MS = 24 * 60 * 60 * 1_000;

let startupCleanup: Promise<void> | undefined;

const SANDBOX_REMOVE_RETRY_DELAYS_MS = [
    50,
    100,
    250,
    500,
    1_000,
    2_000,
    3_000,
    5_000,
];

interface RemoveSandboxRootOptions {
    remove?: (target: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
}

function isRetryableRemoveError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
}

export async function removeSandboxRoot(
    rootDir: string,
    opts: RemoveSandboxRootOptions = {},
): Promise<void> {
    const remove = opts.remove ?? ((target) => fs.remove(target));
    const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const retryDelaysMs = opts.retryDelaysMs ?? SANDBOX_REMOVE_RETRY_DELAYS_MS;

    for (let attempt = 0; ; attempt++) {
        try {
            await remove(rootDir);
            return;
        } catch (error) {
            if (!isRetryableRemoveError(error) || attempt >= retryDelaysMs.length) {
                throw error;
            }
            await sleep(retryDelaysMs[attempt]);
        }
    }
}

interface SandboxMarker {
    version: 1;
    pid: number;
}

export interface StaleSandboxCleanupOptions extends RemoveSandboxRootOptions {
    tempDir?: string;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // A process we cannot signal is still live. Unknown failures are also
        // preserved: cleanup must fail safe rather than delete a live trial.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function readOwnedSandboxMarker(rootDir: string): Promise<SandboxMarker | undefined> {
    const rootStat = await fs.lstat(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;

    const markerPath = path.join(rootDir, SANDBOX_MARKER);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return undefined;

    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as Partial<SandboxMarker>;
    const pid = marker.pid;
    if (marker.version !== 1 || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;

    return { version: 1, pid };
}

async function isStaleOwnedSandbox(
    rootDir: string,
    now: number,
    staleAfterMs: number,
    processIsAlive: (pid: number) => boolean,
): Promise<boolean> {
    const marker = await readOwnedSandboxMarker(rootDir);
    if (!marker) return false;

    const markerStat = await fs.lstat(path.join(rootDir, SANDBOX_MARKER));
    if (now - markerStat.mtimeMs < staleAfterMs) return false;

    return !processIsAlive(marker.pid);
}

/**
 * Removes old, crashed PathGrade sandboxes without examining anything outside
 * the resolved operating-system temp directory. Every filesystem failure is
 * intentionally ignored so a cleanup race never prevents a new trial.
 */
export async function cleanupStaleSandboxes(opts: StaleSandboxCleanupOptions = {}): Promise<void> {
    let tempDir: string;
    try {
        tempDir = await fs.realpath(opts.tempDir ?? os.tmpdir());
    } catch {
        return;
    }

    const now = opts.now ?? Date.now;
    const processIsAlive = opts.isProcessAlive ?? isProcessAlive;
    let entries: fs.Dirent[];
    try {
        entries = await fs.readdir(tempDir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(SANDBOX_PREFIX)) continue;

        const rootDir = path.resolve(tempDir, entry.name);
        if (path.dirname(rootDir) !== tempDir) continue;

        try {
            if (!await isStaleOwnedSandbox(rootDir, now(), STALE_SANDBOX_AGE_MS, processIsAlive)) continue;

            // Re-check ownership and liveness immediately before removal. This
            // narrows the window where another process can replace a candidate.
            if (!await isStaleOwnedSandbox(rootDir, now(), STALE_SANDBOX_AGE_MS, processIsAlive)) continue;
            await removeSandboxRoot(rootDir, opts);
        } catch {
            // A disappeared directory, a permission change, or a deletion race
            // must never make trial creation fail.
        }
    }
}

export async function createSandboxRoot(): Promise<string> {
    // A process may create many trial sandboxes. Scan only once at startup so
    // repeated trials do not pay to enumerate the entire operating-system temp
    // directory, while concurrent creators share the same best-effort sweep.
    startupCleanup ??= cleanupStaleSandboxes();
    await startupCleanup;
    const tempDir = await fs.realpath(os.tmpdir());
    const rootDir = await fs.mkdtemp(path.join(tempDir, SANDBOX_PREFIX));
    const marker: SandboxMarker = { version: 1, pid: process.pid };
    try {
        await fs.writeFile(path.join(rootDir, SANDBOX_MARKER), JSON.stringify(marker), 'utf8');
        return rootDir;
    } catch (error) {
        await fs.remove(rootDir).catch(() => {});
        throw error;
    }
}
