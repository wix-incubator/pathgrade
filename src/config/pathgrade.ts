import * as fs from 'fs';
import * as path from 'path';
import { createJiti } from 'jiti';

export interface PathgradeConfig {
    runner?: {
        adapter?: string;
        args?: string[];
    };
    evals?: {
        include?: string[];
        exclude?: string[];
    };
    affected?: {
        global?: string[];
    };
    reporter?: 'cli' | 'browser' | 'json';
    diagnostics?: boolean;
    verbose?: boolean;
    ci?: {
        threshold?: number;
    };
}

export interface ResolvedPathgradeConfig {
    runner: {
        adapter: string;
        args: string[];
    };
    evals: {
        include: string[];
        exclude: string[];
    };
    affected: {
        global: string[];
    };
    reporter?: 'cli' | 'browser' | 'json';
    diagnostics: boolean;
    verbose: boolean;
    ci: {
        threshold?: number;
    };
}

export const DEFAULT_EVAL_INCLUDE = ['**/*.eval.ts'];

export const DEFAULT_EVAL_EXCLUDE = [
    '**/node_modules/**',
    '**/.git/**',
    '.worktrees/**',
    'worktrees/**',
    '**/fixtures/**',
];

const PATHGRADE_CONFIG_CANDIDATES = [
    'pathgrade.config.ts',
    'pathgrade.config.mts',
    'pathgrade.config.js',
    'pathgrade.config.mjs',
];

export function defaultPathgradeConfig(): ResolvedPathgradeConfig {
    return {
        runner: {
            adapter: 'vitest',
            args: [],
        },
        evals: {
            include: [...DEFAULT_EVAL_INCLUDE],
            exclude: [...DEFAULT_EVAL_EXCLUDE],
        },
        affected: {
            global: [],
        },
        diagnostics: false,
        verbose: false,
        ci: {},
    };
}

export async function resolvePathgradeConfig(input: {
    cwd: string;
    cli?: PathgradeConfig;
    configPath?: string;
    legacyVitestConfigPath?: string;
    warn?: (message: string) => void;
}): Promise<ResolvedPathgradeConfig> {
    const fileConfig = await loadPathgradeConfigFile(input.cwd, input.configPath);
    const legacyConfig = await loadLegacyVitestConfig(
        input.cwd,
        input.legacyVitestConfigPath,
        input.warn,
    );
    return mergePathgradeConfig(
        mergePathgradeConfig(
            mergePathgradeConfig(defaultPathgradeConfig(), legacyConfig),
            fileConfig,
        ),
        input.cli,
    );
}

function mergePathgradeConfig(
    base: ResolvedPathgradeConfig,
    override?: PathgradeConfig,
): ResolvedPathgradeConfig {
    if (!override) return base;
    return {
        runner: {
            adapter: override.runner?.adapter ?? base.runner.adapter,
            args: override.runner?.args ?? base.runner.args,
        },
        evals: {
            include: override.evals?.include ?? base.evals.include,
            exclude: override.evals?.exclude ?? base.evals.exclude,
        },
        affected: {
            global: override.affected?.global ?? base.affected.global,
        },
        reporter: override.reporter ?? base.reporter,
        diagnostics: override.diagnostics ?? base.diagnostics,
        verbose: override.verbose ?? base.verbose,
        ci: {
            threshold: override.ci?.threshold ?? base.ci.threshold,
        },
    };
}

async function loadPathgradeConfigFile(
    cwd: string,
    configPath?: string,
): Promise<PathgradeConfig | undefined> {
    const resolved = configPath
        ? path.resolve(cwd, configPath)
        : PATHGRADE_CONFIG_CANDIDATES
            .map(candidate => path.join(cwd, candidate))
            .find(candidate => fs.existsSync(candidate));
    if (!resolved) return undefined;

    try {
        const jiti = createJiti(cwd, { interopDefault: true });
        const loaded = await jiti.import(resolved, { default: true });
        return validatePathgradeConfig(loaded, path.relative(cwd, resolved));
    } catch (err) {
        if (err instanceof InvalidPathgradeConfigError) {
            throw err;
        }
        throw new Error(`pathgrade: failed to load ${path.relative(cwd, resolved)}: ${errMsg(err)}`);
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

class InvalidPathgradeConfigError extends Error {}

function validatePathgradeConfig(value: unknown, label: string): PathgradeConfig {
    if (!isObject(value)) {
        throw invalidConfig(label, 'default export must be an object');
    }

    validateOptionalObject(value.runner, label, 'runner');
    const runner = asOptionalObject(value.runner);
    validateOptionalString(runner?.adapter, label, 'runner.adapter');
    validateOptionalStringArray(runner?.args, label, 'runner.args');

    validateOptionalObject(value.evals, label, 'evals');
    const evals = asOptionalObject(value.evals);
    validateOptionalStringArray(evals?.include, label, 'evals.include');
    validateOptionalStringArray(evals?.exclude, label, 'evals.exclude');

    validateOptionalObject(value.affected, label, 'affected');
    const affected = asOptionalObject(value.affected);
    validateOptionalStringArray(affected?.global, label, 'affected.global');

    if (value.reporter !== undefined && !['cli', 'browser', 'json'].includes(String(value.reporter))) {
        throw invalidConfig(label, 'reporter must be one of cli, browser, or json');
    }
    validateOptionalBoolean(value.diagnostics, label, 'diagnostics');
    validateOptionalBoolean(value.verbose, label, 'verbose');

    validateOptionalObject(value.ci, label, 'ci');
    const ci = asOptionalObject(value.ci);
    validateOptionalNumber(ci?.threshold, label, 'ci.threshold');

    return value as PathgradeConfig;
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
    return isObject(value) ? value : undefined;
}

function validateOptionalObject(value: unknown, label: string, field: string): void {
    if (value !== undefined && !isObject(value)) {
        throw invalidConfig(label, `${field} must be an object`);
    }
}

function validateOptionalString(value: unknown, label: string, field: string): void {
    if (value !== undefined && typeof value !== 'string') {
        throw invalidConfig(label, `${field} must be a string`);
    }
}

function validateOptionalStringArray(value: unknown, label: string, field: string): void {
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
        throw invalidConfig(label, `${field} must be an array of strings`);
    }
}

function validateOptionalBoolean(value: unknown, label: string, field: string): void {
    if (value !== undefined && typeof value !== 'boolean') {
        throw invalidConfig(label, `${field} must be a boolean`);
    }
}

function validateOptionalNumber(value: unknown, label: string, field: string): void {
    if (value !== undefined && typeof value !== 'number') {
        throw invalidConfig(label, `${field} must be a number`);
    }
}

function invalidConfig(label: string, reason: string): InvalidPathgradeConfigError {
    return new InvalidPathgradeConfigError(`pathgrade: invalid ${label}: ${reason}`);
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const VITEST_CONFIG_CANDIDATES = [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vitest.config.mjs',
];

async function loadLegacyVitestConfig(
    cwd: string,
    configPath?: string,
    warn: (message: string) => void = () => {},
): Promise<PathgradeConfig | undefined> {
    const resolved = configPath
        ? path.resolve(cwd, configPath)
        : VITEST_CONFIG_CANDIDATES
            .map(candidate => path.join(cwd, candidate))
            .find(candidate => fs.existsSync(candidate));
    if (!resolved) return undefined;

    let loaded: unknown;
    try {
        const jiti = createJiti(cwd, { interopDefault: true });
        loaded = await jiti.import(resolved, { default: true });
    } catch (err) {
        const message = `pathgrade: failed to load ${path.relative(cwd, resolved)}: ${errMsg(err)}`;
        if (configPath) throw new Error(message);
        warn(message);
        return undefined;
    }

    const plugins = findPluginsList(loaded);
    const pathgradePlugin = plugins?.find(plugin => isPathgradePlugin(plugin));
    const opts = isObject(pathgradePlugin)
        ? pathgradePlugin.__pathgradeOptions
        : undefined;
    if (!isObject(opts)) return undefined;

    return {
        evals: {
            ...(Array.isArray(opts.include) ? { include: opts.include as string[] } : {}),
            ...(Array.isArray(opts.exclude) ? { exclude: opts.exclude as string[] } : {}),
        },
        affected: {
            global: isObject(opts.affected) && Array.isArray(opts.affected.global)
                ? opts.affected.global as string[]
                : [],
        },
    };
}

function findPluginsList(config: unknown): unknown[] | null {
    if (!isObject(config)) return null;
    if (Array.isArray(config.plugins)) return config.plugins;
    if (isObject(config.test) && Array.isArray(config.test.plugins)) return config.test.plugins;
    return null;
}

function isPathgradePlugin(plugin: unknown): boolean {
    return isObject(plugin) && (
        plugin.name === 'pathgrade' || '__pathgradeOptions' in plugin
    );
}
