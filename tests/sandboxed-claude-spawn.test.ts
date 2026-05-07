/**
 * Tests for src/providers/sandboxed-claude-spawn.ts.
 *
 * Module is the SDK's `spawnClaudeCodeProcess` hook, expressed as a pure
 * function that knows nothing about Claude, the SDK, or evals. It owns two
 * enforcement points:
 *
 *   1. Subprocess env construction. The SDK forwards `Options.env` into the
 *      `SpawnOptions.env` we receive; we intersect the *host process* env
 *      with `SAFE_HOST_VARS` for ambient vars (`PATH`, `SHELL`, `LANG`, ...)
 *      and layer the SDK-provided env on top. Anything not in either source
 *      must not leak through.
 *
 *   2. Argv shape. macOS optionally wraps argv with `sandbox-exec -p <profile>
 *      --` when a profile is supplied; non-darwin always passes through.
 *      Today no profile is staged, so production usage is passthrough on all
 *      platforms — the seam exists for the macOS sandbox-exec wrap preserved
 *      from the pre-SDK driver.
 *
 * All tests inject a fake spawn delegate so no real subprocess runs.
 */

import { describe, expect, it } from 'vitest';
import type {
    SpawnOptions as SdkSpawnOptions,
    SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { createSandboxedClaudeSpawn } from '../src/providers/sandboxed-claude-spawn.js';

interface RecordedSpawn {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
}

function makeSpawnRecorder(): {
    spawn: (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal }) => SpawnedProcess;
    calls: RecordedSpawn[];
} {
    const calls: RecordedSpawn[] = [];
    const fakeProcess = {} as SpawnedProcess;
    return {
        calls,
        spawn: (command, args, opts) => {
            calls.push({ command, args, cwd: opts.cwd, env: opts.env });
            return fakeProcess;
        },
    };
}

function makeSdkSpawnOptions(overrides: Partial<SdkSpawnOptions> = {}): SdkSpawnOptions {
    return {
        command: '/path/to/claude',
        args: ['--version'],
        cwd: '/tmp/workspace',
        env: { ANTHROPIC_API_KEY: 'sk-test' },
        signal: new AbortController().signal,
        ...overrides,
    };
}

describe('sandboxed-claude-spawn — env construction', () => {
    it('passes SAFE_HOST_VARS from the host process through to the subprocess', () => {
        const recorder = makeSpawnRecorder();
        const hostEnv: NodeJS.ProcessEnv = {
            PATH: '/usr/bin:/bin',
            SHELL: '/bin/zsh',
            LANG: 'en_US.UTF-8',
        };

        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv,
            spawn: recorder.spawn,
        });

        spawn(makeSdkSpawnOptions({ env: {} }));

        expect(recorder.calls).toHaveLength(1);
        const env = recorder.calls[0].env;
        expect(env.PATH).toBe('/usr/bin:/bin');
        expect(env.SHELL).toBe('/bin/zsh');
        expect(env.LANG).toBe('en_US.UTF-8');
    });

    it('does not propagate host vars outside SAFE_HOST_VARS (e.g. HOME)', () => {
        const recorder = makeSpawnRecorder();
        const hostEnv: NodeJS.ProcessEnv = {
            PATH: '/usr/bin',
            HOME: '/Users/host',
            SECRET: 'leak-me-please',
        };

        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv,
            spawn: recorder.spawn,
        });

        spawn(makeSdkSpawnOptions({ env: {} }));

        const env = recorder.calls[0].env;
        expect(env.HOME).toBeUndefined();
        expect(env.SECRET).toBeUndefined();
    });

    it('layers SDK-provided env on top of SAFE_HOST_VARS, with SDK winning on collision', () => {
        const recorder = makeSpawnRecorder();
        const hostEnv: NodeJS.ProcessEnv = {
            PATH: '/usr/bin',
            LANG: 'C',
        };

        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv,
            spawn: recorder.spawn,
        });

        spawn(makeSdkSpawnOptions({
            env: {
                ANTHROPIC_API_KEY: 'sk-from-sdk',
                LANG: 'en_US.UTF-8',
                CLAUDE_CONFIG_DIR: '/workspace/.pathgrade-claude-config',
            },
        }));

        const env = recorder.calls[0].env;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-from-sdk');
        expect(env.LANG).toBe('en_US.UTF-8'); // SDK overrode host
        expect(env.CLAUDE_CONFIG_DIR).toBe('/workspace/.pathgrade-claude-config');
        expect(env.PATH).toBe('/usr/bin'); // host SAFE var preserved when SDK didn't touch it
    });

    it('passes the cwd and abort signal through to the spawn delegate', () => {
        const recorder = makeSpawnRecorder();
        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv: {},
            spawn: recorder.spawn,
        });

        const ctrl = new AbortController();
        // Capture the full opts argument by intercepting the recorder.
        let capturedSignal: AbortSignal | undefined;
        let capturedCwd: string | undefined;
        const wrapped = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv: {},
            spawn: (cmd, args, opts) => {
                capturedSignal = opts.signal;
                capturedCwd = opts.cwd;
                return recorder.spawn(cmd, args, opts);
            },
        });

        wrapped(makeSdkSpawnOptions({
            cwd: '/some/workspace',
            env: {},
            signal: ctrl.signal,
        }));

        expect(capturedSignal).toBe(ctrl.signal);
        expect(capturedCwd).toBe('/some/workspace');
        // Avoid lint about unused `spawn` reference.
        void spawn;
    });

    it('drops SDK-provided env entries whose value is undefined', () => {
        // SpawnOptions.env type allows `string | undefined`; treat undefined
        // values as "do not set" so callers can spread `process.env` safely.
        const recorder = makeSpawnRecorder();
        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv: {},
            spawn: recorder.spawn,
        });

        spawn(makeSdkSpawnOptions({
            env: { ANTHROPIC_API_KEY: 'sk-test', UNSET_ME: undefined },
        }));

        const env = recorder.calls[0].env;
        expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
        expect('UNSET_ME' in env).toBe(false);
    });
});

describe('sandboxed-claude-spawn — argv', () => {
    it('passes argv through unchanged on non-darwin platforms', () => {
        const recorder = makeSpawnRecorder();
        const spawn = createSandboxedClaudeSpawn({
            platform: 'linux',
            hostEnv: {},
            spawn: recorder.spawn,
            sandboxProfile: '(version 1)(allow default)', // Ignored off-darwin.
        });

        spawn(makeSdkSpawnOptions({
            command: '/path/to/claude',
            args: ['--print', '-p', 'hello'],
            env: {},
        }));

        expect(recorder.calls[0].command).toBe('/path/to/claude');
        expect(recorder.calls[0].args).toEqual(['--print', '-p', 'hello']);
    });

    it('passes argv through unchanged on darwin when no sandbox profile is supplied', () => {
        // Today's posture: no profile staged → spawn behaves like passthrough
        // even on macOS. Preserves the seam for the future macOS sandbox-exec
        // wrap without forcing it now.
        const recorder = makeSpawnRecorder();
        const spawn = createSandboxedClaudeSpawn({
            platform: 'darwin',
            hostEnv: {},
            spawn: recorder.spawn,
        });

        spawn(makeSdkSpawnOptions({
            command: '/bundled/claude',
            args: ['--mcp-config', 'foo'],
            env: {},
        }));

        expect(recorder.calls[0].command).toBe('/bundled/claude');
        expect(recorder.calls[0].args).toEqual(['--mcp-config', 'foo']);
    });

    it('wraps argv with sandbox-exec on darwin when a sandbox profile is supplied', () => {
        const recorder = makeSpawnRecorder();
        const spawn = createSandboxedClaudeSpawn({
            platform: 'darwin',
            hostEnv: {},
            spawn: recorder.spawn,
            sandboxProfile: '(version 1)(allow default)',
        });

        spawn(makeSdkSpawnOptions({
            command: '/bundled/claude',
            args: ['--print'],
            env: {},
        }));

        expect(recorder.calls[0].command).toBe('sandbox-exec');
        expect(recorder.calls[0].args).toEqual([
            '-p',
            '(version 1)(allow default)',
            '--',
            '/bundled/claude',
            '--print',
        ]);
    });
});
