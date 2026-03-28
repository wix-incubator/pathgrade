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
import {
    buildClaudeMd,
    composeAgentsMd,
    readSkillDescriptors,
    SkillDescriptor,
    stageSkills,
} from './skill-bootstrap';

async function copyCodexAuth(hostHomePath: string, trialHomePath: string): Promise<void> {
    const hostAuthPath = path.join(hostHomePath, '.codex', 'auth.json');
    if (!await fs.pathExists(hostAuthPath)) {
        return;
    }

    const trialCodexDir = path.join(trialHomePath, '.codex');
    await fs.ensureDir(trialCodexDir);
    await fs.copy(hostAuthPath, path.join(trialCodexDir, 'auth.json'));
}

async function copyCodexSupportFiles(hostHomePath: string, trialHomePath: string): Promise<void> {
    const supportDirs = [
        {
            source: path.join(hostHomePath, '.agents', 'skills', 'ck-shared'),
            target: path.join(trialHomePath, '.agents', 'skills', 'ck-shared'),
        },
    ];

    for (const { source, target } of supportDirs) {
        if (!await fs.pathExists(source)) {
            continue;
        }
        await fs.ensureDir(path.dirname(target));
        await fs.copy(source, target);
    }
}

async function stageCodexHomeSkillAliases(trialHomePath: string, skills: SkillDescriptor[]): Promise<void> {
    const skillsRoot = path.join(trialHomePath, '.agents', 'skills');
    await fs.ensureDir(skillsRoot);

    for (const skill of skills) {
        const aliases = new Set([skill.displayName, skill.directoryName]);
        for (const alias of aliases) {
            const targetPath = path.join(skillsRoot, alias);
            if (await fs.pathExists(targetPath)) {
                continue;
            }
            await fs.copy(skill.sourcePath, targetPath);
        }
    }
}

function makeIsolatedRuntime(rootDir: string, workspacePath: string, tmpPath: string, homePath: string, xdgPath: string): TrialRuntime {
    const xdgStatePath = path.join(xdgPath, 'state');
    const xdgCachePath = path.join(xdgPath, 'cache');

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

export class LocalProvider implements EnvironmentProvider {
    async setup(taskPath: string, skillsPaths: string[], opts: EnvironmentSetupOpts, _env?: Record<string, string>): Promise<TrialRuntime> {
        const rootDir = path.join(os.tmpdir(), `pathgrade-${Math.random().toString(36).substring(7)}`);
        const workspacePath = path.join(rootDir, 'workspace');
        const tmpPath = path.join(rootDir, 'tmp');

        await fs.ensureDir(workspacePath);
        await fs.ensureDir(tmpPath);
        await fs.copy(taskPath, workspacePath);

        const skills = await readSkillDescriptors(skillsPaths);

        if (skills.length > 0) {
            await stageSkills(workspacePath, path.join('.agents', 'skills'), skills);
            const claudeSkills = await stageSkills(workspacePath, path.join('.claude', 'skills'), skills);
            const codexSkills = await stageSkills(workspacePath, path.join('.pathgrade', 'skills'), skills);

            const claudeMd = buildClaudeMd(claudeSkills);
            if (claudeMd) {
                await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), claudeMd);
            }

            const agentsMdPath = path.join(workspacePath, 'AGENTS.md');
            const existingAgents = await fs.pathExists(agentsMdPath)
                ? await fs.readFile(agentsMdPath, 'utf-8')
                : null;
            const agentsMd = composeAgentsMd(existingAgents, codexSkills);
            if (agentsMd) {
                await fs.writeFile(agentsMdPath, agentsMd);
            }
        }

        const wantsCodexHostAuth = opts.authMode === 'host' && _env?.PATHGRADE_CODEX_USE_HOST_AUTH === '1';
        if (wantsCodexHostAuth) {
            const homePath = path.join(rootDir, 'home');
            const xdgPath = path.join(rootDir, 'xdg');
            await fs.ensureDir(homePath);
            await fs.ensureDir(path.join(xdgPath, 'state'));
            await fs.ensureDir(path.join(xdgPath, 'cache'));
            await copyCodexAuth(process.env.HOME || os.homedir(), homePath);
            await copyCodexSupportFiles(process.env.HOME || os.homedir(), homePath);
            await stageCodexHomeSkillAliases(homePath, skills);
            return makeIsolatedRuntime(rootDir, workspacePath, tmpPath, homePath, xdgPath);
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

        await fs.ensureDir(homePath);
        await fs.ensureDir(path.join(xdgPath, 'state'));
        await fs.ensureDir(path.join(xdgPath, 'cache'));

        return makeIsolatedRuntime(rootDir, workspacePath, tmpPath, homePath, xdgPath);
    }

    async cleanup(runtime: EnvironmentHandle): Promise<void> {
        const cleanupPath = getRuntimeHandle(runtime);
        if (!await fs.pathExists(cleanupPath)) {
            return;
        }

        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await fs.remove(cleanupPath);
                return;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                const retryable = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
                if (!retryable || attempt === 3) {
                    throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
            }
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
