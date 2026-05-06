/**
 * Adapts the Claude Agent SDK's `spawnClaudeCodeProcess` hook into pathgrade's
 * sandbox model. Knows nothing about Claude, the SDK, or evals — it just
 * receives a `SpawnOptions` and returns a `SpawnedProcess`.
 *
 * Two enforcement points:
 *
 *   1. Subprocess env. The host's ambient env is intersected with
 *      `SAFE_HOST_VARS` (`PATH`, `SHELL`, `LANG`, ...) and the SDK-supplied
 *      `Options.env` is layered on top. Anything else stays out — the
 *      `Options.env` declaration in the driver is the single typed channel
 *      for whatever the SDK subprocess intentionally needs (auth, scratch
 *      config dir, etc.).
 *
 *   2. Argv. macOS optionally wraps with `sandbox-exec -p <profile> --` when
 *      a profile is supplied; non-darwin always passes through. Today no
 *      profile is staged, so production usage is passthrough on every
 *      platform — the seam exists for the wrap that PRD §Architecture
 *      preserves from the pre-SDK driver.
 */
import { spawn as nodeSpawn } from 'child_process';
import type {
    SpawnOptions as SdkSpawnOptions,
    SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { SAFE_HOST_VARS } from './sandbox.js';

/** Injected child_process spawn delegate. Real callers pass node's
 *  `child_process.spawn`; tests pass a recorder. */
export type ChildSpawnFn = (
    command: string,
    args: string[],
    opts: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
) => SpawnedProcess;

export interface SandboxedClaudeSpawnDeps {
    /** Host platform. macOS branches on this when `sandboxProfile` is set. */
    platform: NodeJS.Platform;
    /** Host process env to filter through `SAFE_HOST_VARS`. */
    hostEnv: NodeJS.ProcessEnv;
    /** Spawner. Defaults to `child_process.spawn`. */
    spawn?: ChildSpawnFn;
    /**
     * Inline macOS sandbox-exec profile. When set on darwin, argv is wrapped
     * with `sandbox-exec -p <profile> --`. When unset (today's posture),
     * argv passes through untouched.
     */
    sandboxProfile?: string;
}

export type SandboxedClaudeSpawn = (opts: SdkSpawnOptions) => SpawnedProcess;

export function createSandboxedClaudeSpawn(
    deps: SandboxedClaudeSpawnDeps,
): SandboxedClaudeSpawn {
    const spawn = deps.spawn ?? (nodeSpawn as unknown as ChildSpawnFn);

    return (sdkOpts: SdkSpawnOptions): SpawnedProcess => {
        const env = buildSubprocessEnv(deps.hostEnv, sdkOpts.env);
        const { command, args } = buildArgv(
            deps.platform,
            deps.sandboxProfile,
            sdkOpts.command,
            sdkOpts.args,
        );

        return spawn(command, args, {
            cwd: sdkOpts.cwd,
            env,
            signal: sdkOpts.signal,
        });
    };
}

function buildSubprocessEnv(
    hostEnv: NodeJS.ProcessEnv,
    sdkEnv: SdkSpawnOptions['env'],
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_HOST_VARS) {
        const value = hostEnv[key];
        if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(sdkEnv)) {
        if (value === undefined) continue;
        env[key] = value;
    }
    return env;
}

function buildArgv(
    platform: NodeJS.Platform,
    sandboxProfile: string | undefined,
    command: string,
    args: string[],
): { command: string; args: string[] } {
    if (platform === 'darwin' && sandboxProfile !== undefined) {
        return {
            command: 'sandbox-exec',
            args: ['-p', sandboxProfile, '--', command, ...args],
        };
    }
    return { command, args };
}
