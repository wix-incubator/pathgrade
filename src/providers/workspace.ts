import fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createSandbox, type SandboxConfig } from './sandbox.js';
import { writeMcpConfig } from './mcp-config.js';
import { sandboxExec } from './sandbox-exec.js';
import { resolveCredentials } from './credentials.js';
import type { CommandResult } from '../types.js';

export type { McpSpec } from './mcp-config.js';

export interface Workspace {
    readonly path: string;
    readonly mcpConfigPath: string | undefined;
    readonly env: Record<string, string>;
    readonly setupCommands: string[];
    exec(command: string, opts?: { signal?: AbortSignal }): Promise<CommandResult>;
    dispose(): Promise<void>;
}

async function copyPathsFromHostHome(pathsToCopy: string[], sandboxHomePath: string): Promise<void> {
    const realHome = os.homedir();
    for (const relPath of pathsToCopy) {
        const srcPath = path.join(realHome, relPath);
        if (!await fs.pathExists(srcPath)) continue;
        const destPath = path.join(sandboxHomePath, relPath);
        await fs.ensureDir(path.dirname(destPath));
        await fs.copy(srcPath, destPath);
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

        const { mcpConfigPath } = await writeMcpConfig(workspacePath, mcp);

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

                for (let attempt = 0; attempt < 4; attempt++) {
                    try {
                        await fs.remove(rootDir);
                        return;
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        const retryable = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
                        if (!retryable || attempt === 3) throw error;
                        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
                    }
                }
            },
        };
    } catch (error) {
        await fs.remove(rootDir).catch(() => {});
        throw error;
    }
}
