/**
 * Pure builder that turns pathgrade's per-turn session inputs into the Claude
 * Agent SDK's `Options` object passed to `query()`. The driver class is just
 * orchestration over this builder, the sandboxed-spawn module, the live
 * ask-user bridge, and the SDK message projector.
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
 * or ambient state.
 */
const CLAUDE_CONFIG_SUBDIR = '.pathgrade-claude-config';

export interface ClaudeSdkOptionsInputs {
    /** Per-trial workspace; cwd for the SDK so project-staged skills resolve. */
    workspacePath: string;
    /** Custom spawn hook from the sandboxed-claude-spawn module. */
    spawnClaudeCodeProcess: (opts: SdkSpawnOptions) => SpawnedProcess;
    /** Custom tool-permission callback — the live ask-user bridge. */
    canUseTool: CanUseTool;
    /**
     * The curated workspace runtime env, spread wholesale onto `Options.env`.
     * Carries (1) ANTHROPIC_* credentials resolved by `resolveCredentials()`,
     * (2) sandbox HOME/TMPDIR set by `prepareWorkspace`, and (3) any
     * `createAgent({ env })` keys the user supplied. The driver does not
     * gatekeep which keys reach the SDK subprocess — `prepareWorkspace`
     * curates the workspace env upstream and the sandboxed-spawn module's
     * `SAFE_HOST_VARS` filter defends host-env leakage from a different
     * direction. This is the single env composition point the driver owns.
     */
    runtimeEnv: Record<string, string>;
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
 * default.
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
    // Note on auto-memory hermeticity: the installed SDK has no typed
    // `Options.autoMemoryEnabled` field. The hermetic-default intent ("eval
    // results are not contaminated by personal machine state") is upheld by:
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

    // Env composition ownership: the driver does NOT pluck specific keys.
    // `prepareWorkspace` curates the runtime env (safe host vars, sandbox
    // HOME/TMPDIR, resolveCredentials() output, user-supplied
    // `createAgent({ env })`); the sandboxed-spawn module's SAFE_HOST_VARS
    // filter guards host-env leakage from a different direction. The
    // driver's job is to spread that curated env wholesale onto Options.env,
    // then layer driver-owned hermetic overrides on top — `CLAUDE_CONFIG_DIR`
    // wins on collision so an upstream leak (or a user-supplied env value)
    // cannot weaken the per-trial isolation invariant.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputs.runtimeEnv)) {
        if (value === undefined) continue;
        env[key] = value;
    }
    env.CLAUDE_CONFIG_DIR = path.join(inputs.workspacePath, CLAUDE_CONFIG_SUBDIR);
    opts.env = env;

    return opts;
}
