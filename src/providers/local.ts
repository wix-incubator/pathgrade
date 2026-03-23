import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
    EnvironmentProvider,
    EnvironmentSetupOpts,
    CommandResult,
    EnvironmentHandle,
    TrialRuntime,
    getRuntimeEnv,
    getRuntimeHandle,
    getWorkspacePath,
} from '../types';

export class LocalProvider implements EnvironmentProvider {
    async setup(taskPath: string, skillsPaths: string[], _opts: EnvironmentSetupOpts, _env?: Record<string, string>): Promise<TrialRuntime> {
        const rootDir = path.join(os.tmpdir(), `pathgrade-${Math.random().toString(36).substring(7)}`);
        const workspacePath = path.join(rootDir, 'workspace');
        const homePath = path.join(rootDir, 'home');
        const xdgPath = path.join(rootDir, 'xdg');
        const xdgStatePath = path.join(xdgPath, 'state');
        const xdgCachePath = path.join(xdgPath, 'cache');
        const tmpPath = path.join(rootDir, 'tmp');

        await fs.ensureDir(workspacePath);
        await fs.ensureDir(homePath);
        await fs.ensureDir(xdgStatePath);
        await fs.ensureDir(xdgCachePath);
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

    async runCommand(runtime: EnvironmentHandle, command: string, env?: Record<string, string>): Promise<CommandResult> {
        const workspacePath = getWorkspacePath(runtime);
        return new Promise((resolve) => {
            const child = spawn(command, {
                shell: true,
                cwd: workspacePath,
                env: { ...process.env, ...env, ...getRuntimeEnv(runtime) }
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });

            child.on('close', (code) => {
                resolve({ stdout, stderr, exitCode: code ?? 1 });
            });

            child.on('error', () => {
                resolve({ stdout, stderr, exitCode: 1 });
            });
        });
    }
}
