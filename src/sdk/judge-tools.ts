import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolEvent } from '../tool-events.js';
import type { ToolSchema } from '../utils/llm-types.js';
import type { CodeJudgeToolName, ScorerContext } from './types.js';

export interface RegisteredTool {
    schema: ToolSchema;
    run: (input: Record<string, unknown>, ctx: ScorerContext) => Promise<string>;
}

export interface JudgeToolContext {
    workspace: string;
}

const READ_FILE_MAX_BYTES = 200 * 1024;
const GREP_MAX_MATCHES = 50;
const GREP_MAX_LINE_LEN = 300;
const GREP_MAX_FILES = 5_000;
const GREP_MAX_BYTES = 10 * 1024 * 1024;
const GREP_EXCLUDED_DIRS = new Set(['node_modules']);

/**
 * Resolve a workspace-relative path, rejecting if the resolved path escapes
 * the workspace (including via symlinks).
 *
 * Real-paths the parent directory and appends the basename. We don't realpath
 * the full path because fs.realpath throws ENOENT on missing targets; a naive
 * fallback to path.resolve would not traverse symlinks and could be tricked by
 * a ..-walk against non-existent paths outside the workspace.
 *
 * The lexical fallback for missing-parent paths is unreachable under the tool
 * allowlist (all tools either require an existing target or use resolveInWorkspace
 * on a parent that already exists). Kept for defense in depth.
 */
export async function resolveInWorkspace(workspace: string, relPath: string): Promise<string> {
    if (path.isAbsolute(relPath)) {
        throw new Error(`Path "${relPath}" is outside workspace (absolute paths not allowed)`);
    }
    const workspaceReal = await fs.realpath(workspace);
    const joined = path.resolve(workspaceReal, relPath);

    const parent = path.dirname(joined);
    const basename = path.basename(joined);

    let parentReal: string;
    try {
        parentReal = await fs.realpath(parent);
    } catch {
        const norm = path.resolve(workspaceReal, relPath);
        if (!isInside(workspaceReal, norm)) {
            throw new Error(`Path "${relPath}" is outside workspace`);
        }
        return norm;
    }
    const resolved = path.join(parentReal, basename);
    if (!isInside(workspaceReal, resolved)) {
        throw new Error(`Path "${relPath}" is outside workspace`);
    }
    return resolved;
}

function isInside(root: string, candidate: string): boolean {
    const rel = path.relative(root, candidate);
    if (rel === '') return true;
    if (rel.startsWith('..')) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
}

/**
 * Final-containment check for traversal. Realpaths the full target (it must
 * exist) and rejects if it is not inside the workspace realpath. Used by grep
 * to refuse following symlinks out of the workspace.
 */
async function checkFinalContainment(workspace: string, absolutePath: string): Promise<boolean> {
    try {
        const real = await fs.realpath(absolutePath);
        const workspaceReal = await fs.realpath(workspace);
        return isInside(workspaceReal, real);
    } catch {
        return false;
    }
}

export async function readFile(ctx: JudgeToolContext, relPath: string): Promise<string> {
    const resolved = await resolveInWorkspace(ctx.workspace, relPath);
    let content: string;
    try {
        content = await fs.readFile(resolved, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`File not found: ${relPath}`);
        }
        throw err;
    }
    if (Buffer.byteLength(content, 'utf8') > READ_FILE_MAX_BYTES) {
        const head = content.slice(0, READ_FILE_MAX_BYTES);
        return `${head}\n[truncated at 200KB]`;
    }
    return content;
}

export async function listDir(ctx: JudgeToolContext, relPath: string): Promise<string[]> {
    const resolved = await resolveInWorkspace(ctx.workspace, relPath);
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            throw new Error(`Directory not found: ${relPath}`);
        }
        if (code === 'ENOTDIR') {
            throw new Error(`Not a directory: ${relPath}`);
        }
        throw err;
    }
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

export async function grep(
    ctx: JudgeToolContext,
    pattern: string,
    relPath?: string,
): Promise<string> {
    const rootRel = relPath ?? '.';
    const root = await resolveInWorkspace(ctx.workspace, rootRel);
    const workspaceReal = await fs.realpath(ctx.workspace);

    const regex = new RegExp(pattern);
    const matches: string[] = [];
    let filesVisited = 0;
    let bytesRead = 0;
    let boundedOut = false;

    function collectMatches(filePath: string, content: string): void {
        const displayPath = path.relative(workspaceReal, filePath);
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (matches.length >= GREP_MAX_MATCHES) break;
            if (!regex.test(lines[i])) continue;
            let text = lines[i];
            if (text.length > GREP_MAX_LINE_LEN) {
                text = `${text.slice(0, GREP_MAX_LINE_LEN)}[truncated]`;
            }
            matches.push(`${displayPath}:${i + 1}:${text}`);
        }
    }

    async function scanFile(full: string): Promise<void> {
        filesVisited++;
        if (filesVisited > GREP_MAX_FILES) { boundedOut = true; return; }
        let content: string;
        try {
            content = await fs.readFile(full, 'utf8');
        } catch {
            return;
        }
        bytesRead += Buffer.byteLength(content, 'utf8');
        if (bytesRead > GREP_MAX_BYTES) { boundedOut = true; return; }
        collectMatches(full, content);
    }

    async function walk(dir: string): Promise<void> {
        if (matches.length >= GREP_MAX_MATCHES || boundedOut) return;
        let entries: import('fs').Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (matches.length >= GREP_MAX_MATCHES || boundedOut) return;
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory() && GREP_EXCLUDED_DIRS.has(entry.name)) continue;

            const full = path.join(dir, entry.name);
            if (!(await checkFinalContainment(workspaceReal, full))) continue;

            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile()) {
                await scanFile(full);
            }
        }
    }

    let rootStat;
    try {
        rootStat = await fs.stat(root);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new Error(`Directory not found: ${rootRel}`);
        throw err;
    }
    if (rootStat.isFile()) {
        await scanFile(root);
    } else {
        await walk(root);
    }

    const out = matches.join('\n');
    if (matches.length >= GREP_MAX_MATCHES) {
        return `${out}\n[truncated at ${GREP_MAX_MATCHES} matches]`;
    }
    if (boundedOut) {
        return `${out}\n[traversal truncated: exceeded ${GREP_MAX_FILES} files or ${GREP_MAX_BYTES / (1024 * 1024)}MB]`;
    }
    return out;
}

export async function getToolEvents(
    events: readonly ToolEvent[],
    actionFilter?: string,
): Promise<string> {
    const filtered = actionFilter
        ? events.filter((e) => e.action.includes(actionFilter))
        : events;
    return JSON.stringify(filtered);
}

export const DEFAULT_TOOL_REGISTRY: ReadonlyMap<CodeJudgeToolName, RegisteredTool> = new Map<CodeJudgeToolName, RegisteredTool>([
    ['readFile', {
        schema: {
            name: 'readFile',
            description: 'Read the contents of a file inside the workspace. Content is truncated at 200KB.',
            input_schema: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Workspace-relative path' } },
                required: ['path'],
            },
        },
        async run(input, ctx) {
            const p = input.path;
            if (typeof p !== 'string' || !p) throw new Error('readFile: missing or invalid "path" argument');
            return readFile({ workspace: ctx.workspace }, p);
        },
    }],
    ['listDir', {
        schema: {
            name: 'listDir',
            description: 'List entries in a directory (one level). Directory names get a trailing "/".',
            input_schema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
        },
        async run(input, ctx) {
            const p = input.path;
            if (typeof p !== 'string' || !p) throw new Error('listDir: missing or invalid "path" argument');
            const entries = await listDir({ workspace: ctx.workspace }, p);
            return entries.join('\n');
        },
    }],
    ['grep', {
        schema: {
            name: 'grep',
            description: 'Search a regex pattern through workspace files. Returns path:line:text matches, capped at 50. Dotfiles and node_modules excluded.',
            input_schema: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex pattern (anchored with ^/$ for full line)' },
                    path: { type: 'string', description: 'Optional sub-path to scope the search' },
                },
                required: ['pattern'],
            },
        },
        async run(input, ctx) {
            const pattern = input.pattern;
            if (typeof pattern !== 'string' || !pattern) {
                throw new Error('grep: missing or invalid "pattern" argument');
            }
            const scope = typeof input.path === 'string' && input.path ? input.path : undefined;
            return grep({ workspace: ctx.workspace }, pattern, scope);
        },
    }],
    ['getToolEvents', {
        schema: {
            name: 'getToolEvents',
            description: 'Retrieve the agent session tool events as JSON. Optional actionFilter substring-matches against event.action.',
            input_schema: {
                type: 'object',
                properties: { actionFilter: { type: 'string' } },
            },
        },
        async run(input, ctx) {
            const filter = typeof input.actionFilter === 'string' ? input.actionFilter : undefined;
            return getToolEvents(ctx.toolEvents, filter);
        },
    }],
]);
