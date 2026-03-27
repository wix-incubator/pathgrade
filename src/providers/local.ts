import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
    EnvironmentProvider,
    EnvironmentSetupOpts,
    CommandResult,
    CommandExecutionOptions,
    EnvironmentHandle,
    TrialRuntime,
    getRuntimeEnv,
    getRuntimeHandle,
    getWorkspacePath,
} from '../types';

export class LocalProvider implements EnvironmentProvider {
    async setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, _env?: Record<string, string>): Promise<TrialRuntime> {
        const rootDir = path.join(os.tmpdir(), `pathgrade-${Math.random().toString(36).substring(7)}`);
        const workspacePath = path.join(rootDir, 'workspace');
        const tmpPath = path.join(rootDir, 'tmp');

        await fs.ensureDir(workspacePath);
        await fs.ensureDir(tmpPath);
        await fs.copy(taskPath, workspacePath);

        // Inject skills into agent discovery paths inside the isolated workspace.
        const discoveryDirs = [
            path.join(workspacePath, '.agents', 'skills'),
            path.join(workspacePath, '.claude', 'skills'),
        ];

        for (const skillsDir of discoveryDirs) {
            await fs.ensureDir(skillsDir);
            for (const spath of skillsPaths) {
                const skillName = path.basename(spath);
                await fs.copy(spath, path.join(skillsDir, skillName));
            }
        }

        // Generate a CLAUDE.md that tells the agent about available skills.
        // Without this, the agent may not discover skills in -p (pipe) mode.
        if (skillsPaths.length > 0) {
            const skillEntries: string[] = [];
            for (const spath of skillsPaths) {
                const skillMdPath = path.join(spath, 'SKILL.md');
                if (await fs.pathExists(skillMdPath)) {
                    const content = await fs.readFile(skillMdPath, 'utf-8');
                    // Extract name and description from frontmatter
                    const nameMatch = content.match(/^name:\s*(.+)$/m);
                    const descMatch = content.match(/^description:\s*(.+)$/m);
                    const name = nameMatch?.[1]?.trim() || path.basename(spath);
                    const desc = descMatch?.[1]?.trim() || '';
                    skillEntries.push(`- **${name}**: ${desc}`);
                }
            }

            if (skillEntries.length > 0) {
                const claudeMd = [
                    '# Project Skills',
                    '',
                    'This project has the following skills available. When the user\'s request matches a skill, follow it exactly.',
                    '',
                    ...skillEntries,
                    '',
                    'Skills are located in `.claude/skills/`. Read the SKILL.md to understand the full workflow before responding.',
                ].join('\n');
                await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), claudeMd);
            }
        }

        if (opts.authMode === 'host') {
            // Host-auth passthrough: keep real HOME for CLI auth.
            // Only isolate TMPDIR so agent temp files don't pollute.
            return {
                handle: rootDir,
                workspacePath,
                env: {
                    TMPDIR: tmpPath,
                    TMP: tmpPath,
                    TEMP: tmpPath,
                },
                paths: {
                    root: rootDir,
                    workspace: workspacePath,
                    home: process.env.HOME || os.homedir(),
                    tmp: tmpPath,
                },
            };
        }

        // Isolated mode (default): override HOME to kill CLI auth
        const homePath = path.join(rootDir, 'home');
        const xdgPath = path.join(rootDir, 'xdg');
        const xdgStatePath = path.join(xdgPath, 'state');
        const xdgCachePath = path.join(xdgPath, 'cache');

        await fs.ensureDir(homePath);
        await fs.ensureDir(xdgStatePath);
        await fs.ensureDir(xdgCachePath);

        return {
            handle: rootDir,
            workspacePath,
            env: {
                HOME: homePath,
                XDG_CONFIG_HOME: xdgPath,
                XDG_STATE_HOME: xdgStatePath,
                XDG_CACHE_HOME: xdgCachePath,
                TMPDIR: tmpPath,
                TMP: tmpPath,
                TEMP: tmpPath,
            },
            paths: {
                root: rootDir,
                workspace: workspacePath,
                home: homePath,
                xdg: xdgPath,
                xdgState: xdgStatePath,
                xdgCache: xdgCachePath,
                tmp: tmpPath,
            },
        };
    }

    async cleanup(runtime: EnvironmentHandle): Promise<void> {
        const cleanupPath = getRuntimeHandle(runtime);
        if (await fs.pathExists(cleanupPath)) {
            await fs.remove(cleanupPath);
        }
    }

    async runCommand(
        runtime: EnvironmentHandle,
        command: string,
        env?: Record<string, string>,
        options?: CommandExecutionOptions
    ): Promise<CommandResult> {
        const workspacePath = getWorkspacePath(runtime);
        const runtimeEnv = getRuntimeEnv(runtime);

        // Build the child process environment.
        // In isolated mode (HOME is overridden), use a minimal allowlist
        // to prevent leaking host secrets like API keys and credentials.
        // In host mode, inherit the full host environment.
        const isIsolated = runtimeEnv.HOME !== undefined && runtimeEnv.HOME !== process.env.HOME;
        let childEnv: NodeJS.ProcessEnv;
        if (isIsolated) {
            const SAFE_HOST_VARS = [
                'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME',
            ];
            const baseEnv: Record<string, string> = {};
            for (const key of SAFE_HOST_VARS) {
                if (process.env[key]) baseEnv[key] = process.env[key]!;
            }
            childEnv = { ...baseEnv, ...env, ...runtimeEnv } as NodeJS.ProcessEnv;
        } else {
            childEnv = { ...process.env, ...env, ...runtimeEnv } as NodeJS.ProcessEnv;
        }

        return new Promise((resolve) => {
            const child = spawn(command, {
                shell: true,
                detached: process.platform !== 'win32',
                cwd: workspacePath,
                env: childEnv,
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            let killTimer: NodeJS.Timeout | undefined;

            const finish = (result: CommandResult) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (options?.signal && abortHandler) {
                    options.signal.removeEventListener('abort', abortHandler);
                }
                resolve(result);
            };

            const abortHandler = () => {
                if (settled) return;

                try {
                    if (process.platform !== 'win32' && child.pid) {
                        process.kill(-child.pid, 'SIGTERM');
                    } else {
                        child.kill('SIGTERM');
                    }
                } catch {
                    child.kill('SIGTERM');
                }

                killTimer = setTimeout(() => {
                    try {
                        if (process.platform !== 'win32' && child.pid) {
                            process.kill(-child.pid, 'SIGKILL');
                        } else if (!child.killed) {
                            child.kill('SIGKILL');
                        }
                    } catch {
                        if (!child.killed) {
                            child.kill('SIGKILL');
                        }
                    }
                }, 250);
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    abortHandler();
                } else {
                    options.signal.addEventListener('abort', abortHandler, { once: true });
                }
            }

            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });

            child.on('close', (code, signal) => {
                finish({
                    stdout,
                    stderr,
                    exitCode: code ?? (options?.signal?.aborted ? 124 : 1),
                    timedOut: options?.signal?.aborted || undefined,
                    killed: signal != null || undefined,
                });
            });

            child.on('error', () => {
                finish({
                    stdout,
                    stderr,
                    exitCode: options?.signal?.aborted ? 124 : 1,
                    timedOut: options?.signal?.aborted || undefined,
                });
            });
        });
    }
}
