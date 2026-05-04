import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsExtra from 'fs-extra';
import { readFile, resolveInWorkspace, listDir, grep, getToolEvents, DEFAULT_TOOL_REGISTRY } from '../src/sdk/judge-tools.js';
import type { ToolEvent } from '../src/tool-events.js';
import type { ScorerContext } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';

describe('resolveInWorkspace', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-tools-')),
        );
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    it('resolves a workspace-relative path to an absolute path inside workspace', async () => {
        const resolved = await resolveInWorkspace(workspace, 'a/b.txt');
        expect(resolved).toBe(path.join(workspace, 'a', 'b.txt'));
    });

    it('rejects an absolute path', async () => {
        await expect(resolveInWorkspace(workspace, '/etc/passwd')).rejects.toThrow(/outside workspace/i);
    });

    it('rejects a ..-escape', async () => {
        await expect(resolveInWorkspace(workspace, '../outside.txt')).rejects.toThrow(/outside workspace/i);
    });

    it('rejects a non-existent path under a ..-escape', async () => {
        await expect(
            resolveInWorkspace(workspace, '../nonexistent/still-bad.txt'),
        ).rejects.toThrow(/outside workspace/i);
    });

    it('rejects a path whose parent is a symlink pointing outside the workspace', async () => {
        const outside = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-outside-')),
        );
        try {
            await fs.writeFile(path.join(outside, 'secret.txt'), 'hi');
            await fs.symlink(outside, path.join(workspace, 'link'));

            await expect(resolveInWorkspace(workspace, 'link/secret.txt')).rejects.toThrow(/outside workspace/i);
        } finally {
            await fsExtra.remove(outside).catch(() => {});
        }
    });
});

describe('readFile tool', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-rf-')),
        );
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    it('returns file content for a workspace-relative path', async () => {
        await fs.writeFile(path.join(workspace, 'hello.txt'), 'hi there');
        const out = await readFile({ workspace }, 'hello.txt');
        expect(out).toBe('hi there');
    });

    it('throws for a path that escapes the workspace', async () => {
        await expect(readFile({ workspace }, '../evil.txt')).rejects.toThrow(/outside workspace/i);
    });

    it('throws for a missing file with an actionable message', async () => {
        await expect(readFile({ workspace }, 'missing.txt')).rejects.toThrow(/not found|ENOENT/i);
    });

    it('truncates files over 200KB and appends a trailing marker', async () => {
        const big = 'x'.repeat(210 * 1024);
        await fs.writeFile(path.join(workspace, 'big.txt'), big);
        const out = await readFile({ workspace }, 'big.txt');
        expect(out.length).toBeLessThan(big.length);
        expect(out).toMatch(/\[truncated.*200KB.*\]$/i);
        expect(out.slice(0, 200 * 1024)).toBe(big.slice(0, 200 * 1024));
    });
});

describe('listDir tool', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-ld-')),
        );
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    it('returns one level of entries with / suffix on directories', async () => {
        await fs.writeFile(path.join(workspace, 'a.txt'), '1');
        await fs.mkdir(path.join(workspace, 'sub'));
        await fs.writeFile(path.join(workspace, 'sub', 'nested.txt'), '2');

        const entries = await listDir({ workspace }, '.');
        expect(entries.sort()).toEqual(['a.txt', 'sub/']);
    });

    it('lists a nested directory', async () => {
        await fs.mkdir(path.join(workspace, 'sub'));
        await fs.writeFile(path.join(workspace, 'sub', 'x.md'), 'x');
        const entries = await listDir({ workspace }, 'sub');
        expect(entries).toEqual(['x.md']);
    });

    it('rejects a path that escapes the workspace', async () => {
        await expect(listDir({ workspace }, '..')).rejects.toThrow(/outside workspace/i);
    });

    it('throws for a missing directory', async () => {
        await expect(listDir({ workspace }, 'missing')).rejects.toThrow(/not found|ENOENT/i);
    });

    it('throws when path points at a file, not a directory', async () => {
        await fs.writeFile(path.join(workspace, 'a.txt'), '1');
        await expect(listDir({ workspace }, 'a.txt')).rejects.toThrow(/not a directory/i);
    });
});

describe('grep tool', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-gr-')),
        );
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    it('returns file:line:text triples for matches', async () => {
        await fs.writeFile(path.join(workspace, 'a.md'), 'hello world\nfoo hello\nbye');
        const out = await grep({ workspace }, 'hello');
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toEqual([
            'a.md:1:hello world',
            'a.md:2:foo hello',
        ]);
    });

    it('returns empty string (no matches) for no-hits pattern', async () => {
        await fs.writeFile(path.join(workspace, 'a.md'), 'nothing here');
        const out = await grep({ workspace }, 'zzz');
        expect(out).toBe('');
    });

    it('scopes search to a sub-path when path argument is provided', async () => {
        await fs.writeFile(path.join(workspace, 'top.md'), 'hit');
        await fs.mkdir(path.join(workspace, 'sub'));
        await fs.writeFile(path.join(workspace, 'sub', 'a.md'), 'hit');
        const out = await grep({ workspace }, 'hit', 'sub');
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toEqual(['sub/a.md:1:hit']);
    });

    it('excludes dotfiles and node_modules by default', async () => {
        await fs.writeFile(path.join(workspace, '.secret'), 'hit');
        await fs.mkdir(path.join(workspace, 'node_modules'));
        await fs.writeFile(path.join(workspace, 'node_modules', 'pkg.js'), 'hit');
        await fs.writeFile(path.join(workspace, 'visible.md'), 'hit');
        const out = await grep({ workspace }, 'hit');
        const lines = out.split('\n').filter(Boolean);
        expect(lines).toEqual(['visible.md:1:hit']);
    });

    it('caps output at 50 matches and appends a truncation marker', async () => {
        const lines = Array.from({ length: 60 }, (_, i) => `match ${i + 1}`).join('\n');
        await fs.writeFile(path.join(workspace, 'a.md'), lines);
        const out = await grep({ workspace }, 'match');
        const parts = out.split('\n').filter(Boolean);
        // 50 matches + 1 truncation marker
        expect(parts.length).toBe(51);
        expect(parts[50]).toMatch(/truncated|50 matches/i);
    });

    it('truncates matched lines over 300 chars', async () => {
        const big = `x${'y'.repeat(500)}x`;
        await fs.writeFile(path.join(workspace, 'a.md'), big);
        const out = await grep({ workspace }, 'x');
        const line = out.split('\n')[0];
        expect(line.length).toBeLessThanOrEqual(`a.md:1:`.length + 300 + 20 /* marker */);
    });

    it('rejects a path argument that escapes the workspace', async () => {
        await expect(grep({ workspace }, 'x', '..')).rejects.toThrow(/outside workspace/i);
    });
});

describe('getToolEvents', () => {
    const events: ToolEvent[] = [
        { action: 'read_file', providerToolName: 'Read', provider: 'claude', turnNumber: 1 } as ToolEvent,
        { action: 'write_file', providerToolName: 'Write', provider: 'claude', turnNumber: 2 } as ToolEvent,
        { action: 'run_shell', providerToolName: 'Bash', provider: 'claude', turnNumber: 3 } as ToolEvent,
    ];

    it('returns all events as JSON when no filter is provided', async () => {
        const out = await getToolEvents(events);
        const parsed = JSON.parse(out);
        expect(parsed).toHaveLength(3);
        expect(parsed[0]).toMatchObject({ action: 'read_file', turnNumber: 1 });
    });

    it('filters by action substring', async () => {
        const out = await getToolEvents(events, 'file');
        const parsed = JSON.parse(out) as Array<{ action: string }>;
        expect(parsed.map((e) => e.action)).toEqual(['read_file', 'write_file']);
    });

    it('returns empty array JSON for no matches', async () => {
        const out = await getToolEvents(events, 'zzz-no-match');
        expect(JSON.parse(out)).toEqual([]);
    });
});

describe('DEFAULT_TOOL_REGISTRY', () => {
    it('is a ReadonlyMap keyed by every CodeJudgeToolName', () => {
        expect(DEFAULT_TOOL_REGISTRY).toBeInstanceOf(Map);
        const keys = Array.from(DEFAULT_TOOL_REGISTRY.keys()).sort();
        expect(keys).toEqual(['getToolEvents', 'grep', 'listDir', 'readFile']);
    });

    it('each entry exposes a ToolSchema and an async run()', () => {
        for (const [name, tool] of DEFAULT_TOOL_REGISTRY) {
            expect(tool.schema.name).toBe(name);
            expect(typeof tool.schema.description).toBe('string');
            expect(tool.schema.input_schema).toBeTypeOf('object');
            expect(typeof tool.run).toBe('function');
        }
    });

    it('readFile.run reads a file inside the workspace', async () => {
        const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-reg-')));
        try {
            await fs.writeFile(path.join(ws, 'r.txt'), 'hello');
            const ctx: ScorerContext = {
                workspace: ws,
                log: [],
                transcript: '',
                toolEvents: [],
                runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
                artifacts: { list: () => [], read: async () => '', latest: async () => null },
            };
            const tool = DEFAULT_TOOL_REGISTRY.get('readFile')!;
            const out = await tool.run({ path: 'r.txt' }, ctx);
            expect(out).toBe('hello');
        } finally {
            await fsExtra.remove(ws);
        }
    });
});
