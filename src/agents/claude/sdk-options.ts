/**
 * Pure builder that turns pathgrade's per-turn session inputs into the Claude
 * Agent SDK's `Options` object passed to `query()`. The driver class is just
 * orchestration over this builder, the sandboxed-spawn module, the live
 * ask-user bridge (#004), and the SDK message projector (#002).
 *
 * PRD reference: docs/prds/2026-05-05-claude-sdk-agent-driver.md
 *   §SDK option choices — every default in this file is dictated there.
 */
import * as path from 'path';
import type {
    CanUseTool,
    Options,
    SpawnedProcess,
    SpawnOptions as SdkSpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServersObject } from '../../providers/mcp-config.js';

/**
 * Per-workspace Claude config/home dir. Set via `Options.env.CLAUDE_CONFIG_DIR`
 * so the bundled subprocess does not read host `~/.claude.json`, user memory,
 * or ambient state. PRD §SDK option choices.
 */
const CLAUDE_CONFIG_SUBDIR = '.pathgrade-claude-config';

export interface ClaudeSdkOptionsInputs {
    /** Per-trial workspace; cwd for the SDK so project-staged skills resolve. */
    workspacePath: string;
    /** Custom spawn hook from the sandboxed-claude-spawn module. */
    spawnClaudeCodeProcess: (opts: SdkSpawnOptions) => SpawnedProcess;
    /** Custom tool-permission callback — the live ask-user bridge (#004). */
    canUseTool: CanUseTool;
    /**
     * Auth env from `resolveCredentials()` / `resolveClaude()`. The driver
     * unions this with `CLAUDE_CONFIG_DIR` before passing to `Options.env`;
     * see TB5 for that step.
     */
    authEnv: Record<string, string>;
    /** Forwarded to the SDK only when set. */
    model?: string;
    /**
     * Override for the bundled `claude` binary. Precedence (resolved by the
     * caller): `AgentOptions.claudeCodeExecutable` > `PATHGRADE_CLAUDE_CODE_EXECUTABLE`
     * > undefined (use SDK's bundled per-platform binary).
     */
    claudeCodeExecutable?: string;
    /**
     * Resume session id. Omitted on turn 1; set to the prior turn's
     * `session_id` on every turn after.
     */
    resume?: string;
    /** MCP servers in the SDK's object form, from `loadMcpServersForSdk`. */
    mcpServers?: McpServersObject;
}

/**
 * Pick the Claude executable. Precedence:
 *
 *   1. `AgentOptions.claudeCodeExecutable` — explicit run-level override.
 *   2. `PATHGRADE_CLAUDE_CODE_EXECUTABLE` — process env override.
 *   3. `undefined` — fall back to the SDK's bundled per-platform binary.
 *
 * `undefined` is intentional, not "missing": it tells `buildClaudeSdkOptions`
 * to omit `Options.pathToClaudeCodeExecutable` so the SDK uses its bundled
 * default. PRD §SDK option choices.
 */
export function resolveClaudeCodeExecutable(args: {
    agentOptionsExecutable?: string;
    envExecutable?: string;
}): string | undefined {
    if (args.agentOptionsExecutable) return args.agentOptionsExecutable;
    if (args.envExecutable) return args.envExecutable;
    return undefined;
}

export function buildClaudeSdkOptions(inputs: ClaudeSdkOptionsInputs): Options {
    const opts: Options = {
        cwd: inputs.workspacePath,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
        permissionMode: 'default',
        spawnClaudeCodeProcess: inputs.spawnClaudeCodeProcess,
        canUseTool: inputs.canUseTool,
    };
    // Note on auto-memory hermeticity:
    //
    // The PRD's verification spike claimed `Options.autoMemoryEnabled?: boolean`
    // existed at `sdk.d.ts:4740` against SDK `0.2.100`. Against the installed
    // SDK `0.2.117`, that line lives inside the `Settings` interface, not on
    // `Options` — there is no typed `Options` field for the auto-memory toggle,
    // and setting `{ autoMemoryEnabled: false }` on `Options` is a TS error.
    //
    // The hermetic-default intent ("eval results are not contaminated by
    // personal machine state", User Story #40) is upheld by two other
    // mechanisms the builder already wires up:
    //
    //   1. `CLAUDE_CONFIG_DIR` is set to a per-trial scratch directory under
    //      the workspace, so any auto-memory writes that *do* happen target
    //      `<workspace>/.pathgrade-claude-config/projects/<sanitized-cwd>/memory/`,
    //      which is torn down with the workspace.
    //   2. `settingSources: ['project']` excludes the `'user'` scope, so the
    //      host-level `~/.claude/settings.json`'s `autoMemoryEnabled` (and any
    //      other user-scope state) does not load into the run.
    //
    // If a future SDK release reintroduces `Options.autoMemoryEnabled`, set
    // it to `false` here and remove this note.
    if (inputs.model !== undefined) opts.model = inputs.model;
    if (inputs.claudeCodeExecutable !== undefined) {
        opts.pathToClaudeCodeExecutable = inputs.claudeCodeExecutable;
    }
    if (inputs.resume !== undefined) opts.resume = inputs.resume;
    if (inputs.mcpServers !== undefined) opts.mcpServers = inputs.mcpServers;

    // Env: auth pass-through layered first (filtering out explicit `undefined`
    // values so the SDK's env stays clean); the driver-owned CLAUDE_CONFIG_DIR
    // wins on collision so the hermetic-default invariant cannot be silently
    // weakened by an upstream resolver leaking a host value.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputs.authEnv)) {
        if (value === undefined) continue;
        env[key] = value;
    }
    env.CLAUDE_CONFIG_DIR = path.join(inputs.workspacePath, CLAUDE_CONFIG_SUBDIR);
    opts.env = env;

    return opts;
}
