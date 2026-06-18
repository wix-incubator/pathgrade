import fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createSandbox, type SandboxConfig } from './sandbox.js';
import { stageMcpConfig } from './mcp-config.js';
import { sandboxExec } from './sandbox-exec.js';
import { resolveCredentials } from './credentials.js';
import type { CommandResult } from '../types.js';
import { isPortableCopyEntry } from './copy-filter.js';

export type { McpDeclaration } from './mcp-config.js';

export interface Workspace {
    readonly path: string;
    readonly mcpConfigPath: string | undefined;
    readonly env: Record<string, string>;
    readonly setupCommands: string[];
    exec(command: string, opts?: { signal?: AbortSignal }): Promise<CommandResult>;
    dispose(): Promise<void>;
}

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

async function copyPathsFromHostHome(pathsToCopy: string[], sandboxHomePath: string): Promise<void> {
    const realHome = os.homedir();
    for (const relPath of pathsToCopy) {
        const srcPath = path.join(realHome, relPath);
        if (!await fs.pathExists(srcPath)) continue;
        const destPath = path.join(sandboxHomePath, relPath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(srcPath, destPath, { filter: isPortableCopyEntry });
    }
}

export async function linkPathsFromHostHome(pathsToLink: string[], sandboxHomePath: string): Promise<void> {
    const realHome = os.homedir();
    for (const relPath of pathsToLink) {
        const srcPath = path.join(realHome, relPath);
        if (!await fs.pathExists(srcPath)) continue;
        const destPath = path.join(sandboxHomePath, relPath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.symlink(srcPath, destPath);
    }
}

export async function prepareWorkspace(spec: SandboxConfig): Promise<Workspace> {
    const { mcp, ...sandboxSpec } = spec;
    const sandbox = await createSandbox(sandboxSpec);
    const { workspacePath, homePath, env: sandboxEnv, rootDir } = sandbox;

    try {
        // Resolve credentials: pass user's original env (not sandboxEnv) so
        // the resolver can distinguish explicit user intent from auto-resolved values.
        const creds = await resolveCredentials(spec.agent, spec.env ?? {});
        Object.assign(sandboxEnv, creds.env);
        await copyPathsFromHostHome(creds.copyFromHome, homePath);
        await linkPathsFromHostHome(creds.linkFromHome ?? [], homePath);

        const { mcpConfigPath } = await stageMcpConfig(workspacePath, mcp);

        let disposed = false;

        return {
            path: workspacePath,
            mcpConfigPath,
            env: sandboxEnv,
            setupCommands: creds.setupCommands,

            exec: (command: string, opts?: { signal?: AbortSignal }) =>
                sandboxExec(command, { cwd: workspacePath, env: sandboxEnv }, opts),

            async dispose(): Promise<void> {
                if (disposed) return;
                disposed = true;

                await removeSandboxRoot(rootDir);
            },
        };
    } catch (error) {
        await fs.remove(rootDir).catch(() => {});
        throw error;
    }
}
