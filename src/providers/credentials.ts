/**
 * Credential resolution — determines what auth env vars an agent needs.
 *
 * This module owns the single question: "given user intent and ambient
 * credentials, what auth environment should the agent get?"
 *
 * Precedence (highest to lowest):
 *   1. User-provided env vars (explicit intent — never overridden)
 *   2. Host env vars (forwarded when compatible)
 *   3. macOS Keychain OAuth (Claude only, skipped when explicit intent detected)
 *
 * All external dependencies (Keychain, host env, filesystem) are injectable
 * via CredentialPorts for testability.
 */
import { execSync, execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import fs from 'fs-extra';
import type { AgentName } from '../sdk/types.js';

export interface CredentialPorts {
    /** Read a host environment variable. */
    hostEnv(key: string): string | undefined;
    /** Host platform. */
    platform: NodeJS.Platform;
    /** Host home directory. */
    homedir: string;
    /** Read a macOS Keychain credential. Returns undefined on failure. */
    readKeychainToken(service: string): Promise<string | undefined>;
    /**
     * Check whether a macOS Keychain entry exists for the given service/account
     * without decrypting it (no user prompt, no value returned). Returns false
     * on non-darwin or when the entry is absent.
     */
    keychainEntryExists(service: string, account: string): Promise<boolean>;
    /** Check if a path exists on the host filesystem. */
    fileExists(absolutePath: string): Promise<boolean>;
}

export interface CredentialResult {
    /** Env vars to merge into sandbox env. */
    env: Record<string, string>;
    /** Shell commands to run inside sandbox before first agent turn. */
    setupCommands: string[];
    /** Relative paths from host HOME to copy into sandbox HOME. */
    copyFromHome: string[];
    /**
     * Relative paths from host HOME to symlink into sandbox HOME. Used when
     * the target would be too large to copy or must stay in sync with the
     * host (e.g. macOS `Library/Keychains`). Optional; defaults to none.
     */
    linkFromHome?: string[];
}

const EMPTY: CredentialResult = { env: {}, setupCommands: [], copyFromHome: [] };

/** Default ports using real process.env, Keychain, and filesystem. */
export function defaultPorts(): CredentialPorts {
    return {
        hostEnv: (key) => process.env[key],
        platform: process.platform,
        homedir: os.homedir(),
        async readKeychainToken(service: string): Promise<string | undefined> {
            try {
                const raw = execSync(
                    `security find-generic-password -s "${service}" -w 2>/dev/null`,
                    { encoding: 'utf8', timeout: 5000 },
                ).trim();
                const parsed = JSON.parse(raw);
                return parsed?.claudeAiOauth?.accessToken || undefined;
            } catch {
                return undefined;
            }
        },
        async keychainEntryExists(service: string, account: string): Promise<boolean> {
            if (process.platform !== 'darwin') return false;
            try {
                // execFileSync with argv avoids shell interpretation entirely —
                // no injection surface even if service/account become untrusted.
                execFileSync(
                    'security',
                    ['find-generic-password', '-s', service, '-a', account],
                    { timeout: 5000, stdio: 'ignore' },
                );
                return true;
            } catch {
                return false;
            }
        },
        async fileExists(absolutePath: string): Promise<boolean> {
            return fs.pathExists(absolutePath);
        },
    };
}

export async function resolveCredentials(
    agent: AgentName,
    userEnv: Record<string, string>,
    ports?: CredentialPorts,
): Promise<CredentialResult> {
    const p = ports ?? defaultPorts();

    switch (agent) {
        case 'claude':
            return resolveClaude(userEnv, p);
        case 'codex':
            return resolveCodex(userEnv, p);
        case 'cursor':
            return resolveCursor(userEnv, p);
        default:
            return EMPTY;
    }
}

async function resolveClaude(
    userEnv: Record<string, string>,
    ports: CredentialPorts,
): Promise<CredentialResult> {
    // User explicitly provided API key — trust it, nothing to add
    if (userEnv.ANTHROPIC_API_KEY) {
        return EMPTY;
    }

    // User provided a custom base URL → they're targeting a proxy.
    // Keychain OAuth only works with direct Anthropic, so skip it
    // and forward the host's API key instead.
    if (userEnv.ANTHROPIC_BASE_URL) {
        const hostKey = ports.hostEnv('ANTHROPIC_API_KEY');
        if (!hostKey) {
            throw new Error(
                'ANTHROPIC_BASE_URL is set but no ANTHROPIC_API_KEY found. ' +
                'Provide ANTHROPIC_API_KEY in env or set it in your host environment.',
            );
        }
        return { env: { ANTHROPIC_API_KEY: hostKey }, setupCommands: [], copyFromHome: [] };
    }

    // No explicit Anthropic intent — try auto-resolution.

    // Host-level proxy intent (ANTHROPIC_BASE_URL set on host env) makes the
    // Keychain OAuth token unusable — it's scoped to direct Anthropic, not to
    // a proxy. Skip the Keychain branch so the host-forward fallback wins.
    const hostSignalsProxy = !!ports.hostEnv('ANTHROPIC_BASE_URL');

    // On macOS, prefer Keychain OAuth (direct Anthropic token).
    if (ports.platform === 'darwin' && !hostSignalsProxy) {
        const token = await ports.readKeychainToken('Claude Code-credentials');
        if (token) {
            return { env: { ANTHROPIC_API_KEY: token }, setupCommands: [], copyFromHome: [] };
        }
    }

    // Fallback: forward host API key and base URL.
    const env: Record<string, string> = {};
    const hostKey = ports.hostEnv('ANTHROPIC_API_KEY');
    const hostBaseUrl = ports.hostEnv('ANTHROPIC_BASE_URL');
    if (hostKey) env.ANTHROPIC_API_KEY = hostKey;
    if (hostBaseUrl) env.ANTHROPIC_BASE_URL = hostBaseUrl;
    return { env, setupCommands: [], copyFromHome: [] };
}

async function resolveCursor(
    userEnv: Record<string, string>,
    ports: CredentialPorts,
): Promise<CredentialResult> {
    // User explicitly provided API key — trust it, nothing to add
    if (userEnv.CURSOR_API_KEY) {
        return EMPTY;
    }

    // User provided a custom base URL → they're targeting a proxy.
    // Forward the host's API key; error if missing.
    if (userEnv.CURSOR_API_BASE_URL) {
        const hostKey = ports.hostEnv('CURSOR_API_KEY');
        if (!hostKey) {
            throw new Error(
                'CURSOR_API_BASE_URL is set but no CURSOR_API_KEY found. ' +
                'Provide CURSOR_API_KEY in env or set it in your host environment.',
            );
        }
        return { env: { CURSOR_API_KEY: hostKey }, setupCommands: [], copyFromHome: [] };
    }

    // Forward host key + base URL when user provided neither. OAuth via
    // `cursor-agent login` remains the fallback when neither is set.
    const env: Record<string, string> = {};
    const hostKey = ports.hostEnv('CURSOR_API_KEY');
    const hostBaseUrl = ports.hostEnv('CURSOR_API_BASE_URL');
    if (hostKey) env.CURSOR_API_KEY = hostKey;
    if (hostBaseUrl) env.CURSOR_API_BASE_URL = hostBaseUrl;

    // On macOS, `cursor-agent login` stores OAuth tokens in the host's login
    // keychain at `~/Library/Keychains`. The sandbox runs with an isolated
    // HOME so the CLI looks in the sandbox's (empty) Library/Keychains and
    // reports "Authentication required". Symlink the host keychain dir in
    // so the token is visible. Only meaningful when no explicit API key is
    // set — otherwise cursor-agent uses the env var and ignores the keychain.
    const linkFromHome: string[] = [];
    if (!hostKey) {
        if (ports.platform === 'darwin') {
            // cursor-agent stores OAuth tokens under the `cursor-access-token`
            // service / `cursor-user` account. Probe before sandbox creation:
            // if the user hasn't run `cursor-agent login`, surface that now
            // rather than 17s into the first turn.
            const loggedIn = await ports.keychainEntryExists('cursor-access-token', 'cursor-user');
            if (!loggedIn) {
                throw new Error(
                    'Cursor authentication required but no OAuth tokens were found in the login keychain. ' +
                    'Run `cursor-agent login` first, or set CURSOR_API_KEY in your environment.',
                );
            }
            linkFromHome.push('Library/Keychains');
        } else {
            // No API key and no keychain-equivalent we know how to wire up.
            throw new Error(
                'Cursor authentication required but CURSOR_API_KEY is not set. ' +
                'Auto-detection via `cursor-agent login` is only supported on macOS. ' +
                'On other platforms, generate an API key from the Cursor dashboard ' +
                'and set CURSOR_API_KEY in your environment.',
            );
        }
    }

    return { env, setupCommands: [], copyFromHome: [], linkFromHome };
}

async function resolveCodex(
    userEnv: Record<string, string>,
    ports: CredentialPorts,
): Promise<CredentialResult> {
    const env: Record<string, string> = {};
    const setupCommands: string[] = [];
    const copyFromHome: string[] = [];

    const hasUserKey = !!userEnv.OPENAI_API_KEY;
    const hasUserBaseUrl = !!userEnv.OPENAI_BASE_URL;

    // User provided a custom base URL → they're targeting a proxy.
    // Forward the host key; error if missing.
    if (hasUserBaseUrl && !hasUserKey) {
        const hostKey = ports.hostEnv('OPENAI_API_KEY');
        if (!hostKey) {
            throw new Error(
                'OPENAI_BASE_URL is set but no OPENAI_API_KEY found. ' +
                'Provide OPENAI_API_KEY in env or set it in your host environment.',
            );
        }
        env.OPENAI_API_KEY = hostKey;
    }

    // Forward host keys when user didn't provide them
    if (!hasUserKey && !hasUserBaseUrl) {
        const hostKey = ports.hostEnv('OPENAI_API_KEY');
        const hostBaseUrl = ports.hostEnv('OPENAI_BASE_URL');
        if (hostKey) env.OPENAI_API_KEY = hostKey;
        if (hostBaseUrl) env.OPENAI_BASE_URL = hostBaseUrl;
    }

    // Determine if we have a key (user-provided or host-forwarded)
    const hasKey = hasUserKey || !!env.OPENAI_API_KEY;
    const hasBaseUrl = hasUserBaseUrl || !!env.OPENAI_BASE_URL;

    if (hasKey) {
        // Proxied OpenAI-compatible endpoints use a custom Codex provider that
        // reads OPENAI_API_KEY directly from env, so no auth cache/login is needed.
        if (!hasBaseUrl) {
            setupCommands.push(
                'if [ ! -d "$HOME/.codex" ] && [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi',
            );
        }
    } else {
        // No key — check for cached auth.json
        const authCachePath = path.join(ports.homedir, '.codex', 'auth.json');
        if (await ports.fileExists(authCachePath)) {
            copyFromHome.push('.codex/auth.json');
        }
    }

    return { env, setupCommands, copyFromHome };
}
