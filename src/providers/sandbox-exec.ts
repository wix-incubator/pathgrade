import { spawn } from 'child_process';
import type { CommandResult } from '../types.js';

export interface ExecContext {
    cwd: string;
    env: Record<string, string>;
}

export function sandboxExec(
    command: string,
    ctx: ExecContext,
    opts?: { signal?: AbortSignal },
): Promise<CommandResult> {
    return new Promise((resolve) => {
        const child = spawn(command, {
            shell: true,
            detached: process.platform !== 'win32',
            cwd: ctx.cwd,
            env: { ...ctx.env } as NodeJS.ProcessEnv,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;

        const finish = (result: CommandResult) => {
            if (settled) return;
            settled = true;
            if (killTimer) clearTimeout(killTimer);
            if (opts?.signal && abortHandler) {
                opts.signal.removeEventListener('abort', abortHandler);
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
                    if (!child.killed) child.kill('SIGKILL');
                }
            }, 250);
        };

        if (opts?.signal) {
            if (opts.signal.aborted) {
                abortHandler();
            } else {
                opts.signal.addEventListener('abort', abortHandler, { once: true });
            }
        }

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });

        child.on('close', (code, signal) => {
            finish({
                stdout,
                stderr,
                exitCode: code ?? (opts?.signal?.aborted ? 124 : 1),
                timedOut: opts?.signal?.aborted || undefined,
                killed: signal != null || undefined,
            });
        });

        child.on('error', () => {
            finish({
                stdout,
                stderr,
                exitCode: opts?.signal?.aborted ? 124 : 1,
                timedOut: opts?.signal?.aborted || undefined,
            });
        });
    });
}
