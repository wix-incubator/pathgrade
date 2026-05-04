import * as fs from 'fs';
import * as path from 'path';
import { configDefaults } from 'vitest/config';
import type { PathgradePluginOptions } from '../sdk/types.js';
import { PathgradeReporter } from './reporter.js';

export type { PathgradePluginOptions };

const DEFAULT_EXCLUDE = [...configDefaults.exclude, '.worktrees/**', 'worktrees/**'];

function resolveSetupFile(): string {
    // Prefer .ts (running from source via vitest) over .js (built dist)
    const tsPath = path.resolve(import.meta.dirname, 'setup.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    return path.resolve(import.meta.dirname, 'setup.js');
}

/**
 * Vitest plugin for pathgrade evaluations.
 *
 * Configures test file patterns, timeout, auto-dispose lifecycle hooks,
 * and the pathgrade reporter for aggregate statistics.
 */
export function pathgrade(opts?: PathgradePluginOptions): any {
    const timeoutSec = opts?.timeout ?? 300;

    // Verbose live-streaming seam: the SDK (createAgent) reads
    // `process.env.PATHGRADE_VERBOSE` to decide whether to emit. Wiring the
    // plugin option through the env var keeps a single source of truth and
    // preserves CLI/env precedence — we only set the env if the user hasn't
    // already set it via their shell or the `pathgrade run --verbose` CLI.
    if (opts?.verbose === true && process.env.PATHGRADE_VERBOSE === undefined) {
        process.env.PATHGRADE_VERBOSE = '1';
    }

    return {
        name: 'pathgrade',
        // Surface the user's options to pre-vitest CLI commands
        // (`pathgrade affected`, `pathgrade run --changed`) so they can
        // read `affected.global` after loading vitest.config.ts.
        // See `src/affected/config.ts`.
        __pathgradeOptions: opts ?? {},
        config() {
            return {
                resolve: {
                    alias: resolveLocalAliases(),
                },
                test: {
                    include: opts?.include ?? ['**/*.eval.ts'],
                    exclude: opts?.exclude ?? DEFAULT_EXCLUDE,
                    testTimeout: (timeoutSec + 30) * 1000,
                    setupFiles: [resolveSetupFile()],
                    reporters: [
                        'default',
                        new PathgradeReporter(opts),
                    ],
                },
            };
        },
    };
}

/**
 * When running from source (not installed via npm), resolve
 * `pathgrade` imports to the local src/ directory so examples
 * can use canonical package imports while developing locally.
 */
function resolveLocalAliases(): Record<string, string> | undefined {
    const sdkSource = path.resolve(import.meta.dirname, '..', 'sdk', 'index.ts');
    if (!fs.existsSync(sdkSource)) return undefined;

    const src = path.resolve(import.meta.dirname, '..');
    return {
        'pathgrade/mcp-mock': path.join(src, 'core', 'mcp-mock.ts'),
        'pathgrade/plugin': path.join(src, 'plugin', 'index.ts'),
        'pathgrade': path.join(src, 'sdk', 'index.ts'),
    };
}
