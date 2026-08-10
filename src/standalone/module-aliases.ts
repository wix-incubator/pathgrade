import fs from 'node:fs';
import path from 'node:path';

export const STANDALONE_VITEST_PAYLOAD_ENV =
    'PATHGRADE_STANDALONE_VITEST_PAYLOAD' as const;

export interface StandaloneVitestPayload {
    root: string;
    include: string[];
    exclude: string[];
    diagnostics: boolean;
    reporter?: 'cli' | 'browser' | 'json';
    threshold?: number;
    cacheDir: string;
}

export function encodeStandaloneVitestPayload(
    payload: StandaloneVitestPayload,
): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeStandaloneVitestPayload(
    value: string | undefined,
): StandaloneVitestPayload {
    if (!value) throw new Error('pathgrade standalone: missing internal Vitest payload');

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw new Error('pathgrade standalone: invalid internal Vitest payload');
    }
    if (!isRecord(parsed)) {
        throw new Error('pathgrade standalone: invalid internal Vitest payload');
    }

    const root = requireAbsolutePath(parsed.root, 'root');
    const cacheDir = requireAbsolutePath(parsed.cacheDir, 'cacheDir');
    const include = requireStringArray(parsed.include, 'include');
    const exclude = requireStringArray(parsed.exclude, 'exclude');
    if (typeof parsed.diagnostics !== 'boolean') {
        throw new Error('pathgrade standalone: payload diagnostics must be a boolean');
    }
    if (
        parsed.reporter !== undefined
        && parsed.reporter !== 'cli'
        && parsed.reporter !== 'browser'
        && parsed.reporter !== 'json'
    ) {
        throw new Error('pathgrade standalone: payload reporter is unsupported');
    }
    if (
        parsed.threshold !== undefined
        && (typeof parsed.threshold !== 'number' || !Number.isFinite(parsed.threshold))
    ) {
        throw new Error('pathgrade standalone: payload threshold must be finite');
    }

    return {
        root,
        include,
        exclude,
        diagnostics: parsed.diagnostics,
        ...(parsed.reporter === undefined ? {} : { reporter: parsed.reporter }),
        ...(parsed.threshold === undefined ? {} : { threshold: parsed.threshold }),
        cacheDir,
    };
}

function requireAbsolutePath(value: unknown, field: string): string {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw new Error(`pathgrade standalone: payload ${field} must be an absolute path`);
    }
    return value;
}

function requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`pathgrade standalone: payload ${field} must be an array of strings`);
    }
    return [...value] as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SUPPORTED_ESM_CONDITIONS = new Set(['node', 'import', 'default']);

export function selectStandaloneEsmExportTarget(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!isRecord(value)) return undefined;

    for (const [condition, target] of Object.entries(value)) {
        if (!SUPPORTED_ESM_CONDITIONS.has(condition)) continue;
        const selected = selectStandaloneEsmExportTarget(target);
        if (selected) return selected;
    }
    return undefined;
}

const STANDALONE_EVAL_EXPORTS = [
    ['.', '@wix/pathgrade'],
    ['./mcp-mock', '@wix/pathgrade/mcp-mock'],
] as const;

export function resolveStandaloneModuleAliases(
    packageRoot: string,
    vitestEntry: string,
): Array<{ find: RegExp; replacement: string }> {
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { exports?: Record<string, unknown> };
    const exportsMap = packageJson.exports ?? {};
    const aliases: Array<{ find: RegExp; replacement: string }> = [];

    for (const [exportKey, specifier] of STANDALONE_EVAL_EXPORTS) {
        const target = selectStandaloneEsmExportTarget(exportsMap[exportKey]);
        if (!target) continue;
        aliases.push({
            find: new RegExp(`^${escapeRegExp(specifier)}$`),
            replacement: path.resolve(packageRoot, target),
        });
    }

    aliases.push({
        find: /^vitest$/,
        replacement: vitestEntry,
    });
    return aliases;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
