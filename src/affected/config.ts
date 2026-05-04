/**
 * Load `vitest.config.ts` at CLI time and extract the pathgrade plugin's
 * `affected.global` configuration.
 *
 * Why this file exists: `pathgrade()` runs *inside* the vitest process, but
 * `pathgrade affected` / `pathgrade run --changed` compute selection
 * *before* vitest spawns. So the CLI must read the plugin's options itself.
 * We do that by importing the user's `vitest.config.ts` via `jiti`
 * (already a pathgrade dependency), walking the resulting plugin list, and
 * finding the pathgrade plugin instance — which annotates itself with
 * `__pathgradeOptions` so that pre-vitest tooling can extract its options
 * without re-executing the plugin factory.
 *
 * v1 limitation: `vitest.workspace.ts` is detected and warned about, but
 * not traversed. Affected-selection still works via per-eval deps; only
 * the `affected.global` short-circuit is disabled in workspace mode.
 * Documented in USER_GUIDE for Issue 14.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createJiti } from 'jiti';

export interface AffectedConfig {
    global: string[];
}

export interface LoadOptions {
    onWarning?: (message: string) => void;
}

const VITEST_CONFIG_CANDIDATES = [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vitest.config.mjs',
];

const WORKSPACE_CANDIDATES = [
    'vitest.workspace.ts',
    'vitest.workspace.js',
    'vitest.workspace.mts',
    'vitest.workspace.mjs',
];

export async function loadAffectedConfig(
    repoRoot: string,
    options: LoadOptions = {},
): Promise<AffectedConfig> {
    const warn = options.onWarning ?? (() => {});

    // v1 limitation: workspace mode skips the short-circuit.
    for (const candidate of WORKSPACE_CANDIDATES) {
        if (fs.existsSync(path.join(repoRoot, candidate))) {
            warn(
                `pathgrade: ${candidate} detected — v1 does not read affected.global from workspace configs; ` +
                `selection will still work, but the repo-wide short-circuit is disabled.`,
            );
            return { global: [] };
        }
    }

    const configPath = VITEST_CONFIG_CANDIDATES
        .map(c => path.join(repoRoot, c))
        .find(p => fs.existsSync(p));
    if (!configPath) return { global: [] };

    let loaded: unknown;
    try {
        const jiti = createJiti(repoRoot, { interopDefault: true });
        loaded = await jiti.import(configPath, { default: true });
    } catch (err) {
        warn(`pathgrade: failed to load ${path.relative(repoRoot, configPath)}: ${errMsg(err)}`);
        return { global: [] };
    }

    const plugins = findPluginsList(loaded);
    if (!plugins) {
        warn(`pathgrade: no plugin list found in ${path.relative(repoRoot, configPath)}`);
        return { global: [] };
    }

    const pathgradePlugin = plugins.find(p => isPathgradePlugin(p));
    if (!pathgradePlugin) {
        warn(
            `pathgrade: no pathgrade plugin found in ${path.relative(repoRoot, configPath)} — ` +
            `affected.global will be empty. Add \`pathgrade()\` to your vitest plugins list.`,
        );
        return { global: [] };
    }

    const opts = (pathgradePlugin as any).__pathgradeOptions ?? {};
    const global = opts.affected?.global;
    return { global: Array.isArray(global) ? global : [] };
}

/**
 * Given a loaded vitest config (either the raw export or a `defineConfig()`
 * result), locate the plugin array. Supports both:
 *   - `defineConfig({ plugins: [...] })`  (top-level)
 *   - `defineConfig({ test: { plugins: [...] } })` (vitest convention)
 */
function findPluginsList(config: unknown): unknown[] | null {
    if (!config || typeof config !== 'object') return null;
    const c = config as Record<string, any>;
    if (Array.isArray(c.plugins)) return c.plugins;
    if (c.test && typeof c.test === 'object' && Array.isArray(c.test.plugins)) {
        return c.test.plugins;
    }
    return null;
}

function isPathgradePlugin(plugin: unknown): boolean {
    if (!plugin || typeof plugin !== 'object') return false;
    const p = plugin as Record<string, any>;
    return p.name === 'pathgrade' || '__pathgradeOptions' in p;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
