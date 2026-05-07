/**
 * Tests for src/agents/claude/sdk-options.ts — pure builder that turns
 * pathgrade's per-turn session inputs into the Claude Agent SDK's `Options`
 * object passed to `query()`.
 */

import { describe, expect, it } from 'vitest';
import {
    buildClaudeSdkOptions,
    resolveClaudeCodeExecutable,
    type ClaudeSdkOptionsInputs,
} from '../src/agents/claude/sdk-options.js';

const noopSpawn = (() => {
    throw new Error('spawn fn used in test');
}) as unknown as ClaudeSdkOptionsInputs['spawnClaudeCodeProcess'];

const noopCanUseTool = (async () => ({
    behavior: 'allow' as const,
    updatedInput: {},
})) as unknown as ClaudeSdkOptionsInputs['canUseTool'];

function baseInputs(overrides: Partial<ClaudeSdkOptionsInputs> = {}): ClaudeSdkOptionsInputs {
    return {
        workspacePath: '/tmp/workspace',
        spawnClaudeCodeProcess: noopSpawn,
        canUseTool: noopCanUseTool,
        runtimeEnv: {},
        ...overrides,
    };
}

describe('buildClaudeSdkOptions — base options (TB4)', () => {
    it('sets the Claude Code system-prompt preset', () => {
        const opts = buildClaudeSdkOptions(baseInputs());
        expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('sets settingSources to ["project"] for hermetic project-only loading', () => {
        // SDK omitted/empty default is `[]` → full isolation, no CLAUDE.md.
        // The driver explicitly opts into project sources because fixture-staged
        // skill discovery requires it; user/local stay off.
        const opts = buildClaudeSdkOptions(baseInputs());
        expect(opts.settingSources).toEqual(['project']);
    });

    it('keeps auto-memory state out of the SDK Options object', () => {
        // The installed SDK has no typed `Options.autoMemoryEnabled` field
        // — that lives on `Settings`, and writing it through `Options` is a
        // TS error. The hermetic-default intent is upheld via two other
        // mechanisms:
        //
        //   - `CLAUDE_CONFIG_DIR` is set to a per-trial scratch dir below
        //     (TB5), so memory writes never touch the host filesystem.
        //   - `settingSources: ['project']` excludes the `'user'` scope, so
        //     host `~/.claude/settings.json` (where the user-scope memory
        //     toggle lives) is not loaded.
        //
        // The builder must therefore NOT carry an `autoMemoryEnabled` key
        // on Options — keeping it absent is the correct contract.
        const opts = buildClaudeSdkOptions(baseInputs());
        expect('autoMemoryEnabled' in opts).toBe(false);
    });

    it('sets permissionMode to "default" so canUseTool fires for every tool decision', () => {
        const opts = buildClaudeSdkOptions(baseInputs());
        expect(opts.permissionMode).toBe('default');
    });

    it('passes the cwd through from the workspace path', () => {
        const opts = buildClaudeSdkOptions(baseInputs({ workspacePath: '/some/abs/ws' }));
        expect(opts.cwd).toBe('/some/abs/ws');
    });

    it('forwards the model when supplied and omits it when not', () => {
        const withModel = buildClaudeSdkOptions(baseInputs({ model: 'claude-opus-4-7' }));
        expect(withModel.model).toBe('claude-opus-4-7');

        const withoutModel = buildClaudeSdkOptions(baseInputs());
        expect(withoutModel.model).toBeUndefined();
    });

    it('installs the supplied custom spawn and canUseTool callbacks', () => {
        const customSpawn = noopSpawn;
        const customCanUseTool = noopCanUseTool;
        const opts = buildClaudeSdkOptions(baseInputs({
            spawnClaudeCodeProcess: customSpawn,
            canUseTool: customCanUseTool,
        }));
        expect(opts.spawnClaudeCodeProcess).toBe(customSpawn);
        expect(opts.canUseTool).toBe(customCanUseTool);
    });

    it('does not set allowedTools (full Claude tool surface stays available)', () => {
        const opts = buildClaudeSdkOptions(baseInputs());
        expect('allowedTools' in opts).toBe(false);
    });
});

describe('buildClaudeSdkOptions — env (TB5)', () => {
    it('passes the auth env through into Options.env', () => {
        const opts = buildClaudeSdkOptions(baseInputs({
            runtimeEnv: {
                ANTHROPIC_API_KEY: 'sk-test',
                ANTHROPIC_BASE_URL: 'https://proxy.example/v1',
            },
        }));
        expect(opts.env).toBeDefined();
        expect(opts.env!.ANTHROPIC_API_KEY).toBe('sk-test');
        expect(opts.env!.ANTHROPIC_BASE_URL).toBe('https://proxy.example/v1');
    });

    it('sets CLAUDE_CONFIG_DIR to a per-workspace scratch directory', () => {
        // `<workspace>/.pathgrade-claude-config/` keeps host `~/.claude.json`,
        // user memory, and ambient state from leaking into default CI runs.
        const opts = buildClaudeSdkOptions(baseInputs({
            workspacePath: '/tmp/trial-42',
            runtimeEnv: {},
        }));
        expect(opts.env).toBeDefined();
        expect(opts.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/trial-42/.pathgrade-claude-config');
    });

    it('does not set Options.env keys whose values are undefined in the auth env', () => {
        // resolveClaude() only emits keys it actually has values for, but a
        // future helper might pass through optional keys. The builder treats
        // explicit `undefined` as "do not set" so the SDK's env stays clean.
        const opts = buildClaudeSdkOptions(baseInputs({
            runtimeEnv: { ANTHROPIC_API_KEY: 'sk-test', UNSET: undefined as unknown as string },
        }));
        expect(opts.env!.ANTHROPIC_API_KEY).toBe('sk-test');
        expect('UNSET' in opts.env!).toBe(false);
    });

    it('does not let auth env shadow the driver-owned CLAUDE_CONFIG_DIR', () => {
        // The scratch dir is a hermetic-default invariant. Even if
        // resolveCredentials someday emitted CLAUDE_CONFIG_DIR (it does not
        // today), the driver's per-workspace value must win.
        const opts = buildClaudeSdkOptions(baseInputs({
            workspacePath: '/tmp/trial-7',
            runtimeEnv: { CLAUDE_CONFIG_DIR: '/leaked/host/path' },
        }));
        expect(opts.env!.CLAUDE_CONFIG_DIR).toBe('/tmp/trial-7/.pathgrade-claude-config');
    });
});

describe('resolveClaudeCodeExecutable — override precedence (TB6)', () => {
    it('returns undefined when neither AgentOptions nor env supplies an override', () => {
        // undefined → SDK uses the bundled per-platform `claude` binary,
        // which is the desired default for reproducible eval runs.
        const exe = resolveClaudeCodeExecutable({
            agentOptionsExecutable: undefined,
            envExecutable: undefined,
        });
        expect(exe).toBeUndefined();
    });

    it('uses PATHGRADE_CLAUDE_CODE_EXECUTABLE when no AgentOptions override is set', () => {
        const exe = resolveClaudeCodeExecutable({
            agentOptionsExecutable: undefined,
            envExecutable: '/from/env/claude',
        });
        expect(exe).toBe('/from/env/claude');
    });

    it('AgentOptions.claudeCodeExecutable wins over the env variable', () => {
        // Run-level precedence: explicit AgentOptions beats process env.
        const exe = resolveClaudeCodeExecutable({
            agentOptionsExecutable: '/from/opts/claude',
            envExecutable: '/from/env/claude',
        });
        expect(exe).toBe('/from/opts/claude');
    });

    it('AgentOptions wins even when env is empty string', () => {
        const exe = resolveClaudeCodeExecutable({
            agentOptionsExecutable: '/from/opts/claude',
            envExecutable: '',
        });
        expect(exe).toBe('/from/opts/claude');
    });

    it('plumbs the resolved executable into Options.pathToClaudeCodeExecutable', () => {
        const opts = buildClaudeSdkOptions(baseInputs({
            claudeCodeExecutable: '/local/dev/claude',
        }));
        expect(opts.pathToClaudeCodeExecutable).toBe('/local/dev/claude');
    });

    it('omits Options.pathToClaudeCodeExecutable when no override is supplied', () => {
        const opts = buildClaudeSdkOptions(baseInputs());
        expect('pathToClaudeCodeExecutable' in opts).toBe(false);
    });
});

describe('buildClaudeSdkOptions — resume (TB7)', () => {
    it('omits Options.resume on the first turn (no resume id passed)', () => {
        const opts = buildClaudeSdkOptions(baseInputs({ resume: undefined }));
        expect('resume' in opts).toBe(false);
    });

    it('passes Options.resume on subsequent turns using the prior session_id', () => {
        const opts = buildClaudeSdkOptions(baseInputs({ resume: 'sess-abc-123' }));
        expect(opts.resume).toBe('sess-abc-123');
    });
});

describe('buildClaudeSdkOptions — mcpServers wiring (TB8)', () => {
    it('omits Options.mcpServers when no MCP config is loaded', () => {
        const opts = buildClaudeSdkOptions(baseInputs());
        expect('mcpServers' in opts).toBe(false);
    });

    it('passes the loader-supplied mcpServers object straight through', () => {
        // The loader already shapes the data into the SDK's
        // `Record<string, McpStdioServerConfig>` form; the builder is just a
        // pass-through, no field renaming or shape massaging.
        const mcpServers = {
            'mock-greeter': { command: 'node', args: ['/srv.js', '/fixture.json'] },
            'real-passthrough': { command: 'real-mcp', args: [] },
        };
        const opts = buildClaudeSdkOptions(baseInputs({ mcpServers }));
        expect(opts.mcpServers).toBe(mcpServers);
    });
});
