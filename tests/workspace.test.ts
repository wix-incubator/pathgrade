import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { prepareWorkspace, linkPathsFromHostHome, Workspace } from '../src/providers/workspace.js';

describe('prepareWorkspace — MCP config', () => {
    let workspace: Workspace | undefined;
    let fixtureDir: string;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
        if (fixtureDir) await fs.remove(fixtureDir).catch(() => {});
    });

    it('copies MCP config file into workspace and sets mcpConfigPath', async () => {
        fixtureDir = path.join(os.tmpdir(), `pg-mcp-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        const configContent = { mcpServers: { test: { command: 'echo' } } };
        await fs.writeJson(path.join(fixtureDir, 'mcp.json'), configContent);

        workspace = await prepareWorkspace({
            agent: 'claude',
            mcp: { configFile: path.join(fixtureDir, 'mcp.json') },
        });

        expect(workspace.mcpConfigPath).toBe('.pathgrade-mcp.json');
        const copied = await fs.readJson(path.join(workspace.path, '.pathgrade-mcp.json'));
        expect(copied).toEqual(configContent);
    });

    it('throws when MCP config file does not exist', async () => {
        await expect(prepareWorkspace({
            agent: 'claude',
            mcp: { configFile: '/nonexistent/mcp.json' },
        })).rejects.toThrow('not found');
    });

    it('mcpConfigPath is undefined when no MCP is configured', async () => {
        workspace = await prepareWorkspace({ agent: 'claude' });
        expect(workspace.mcpConfigPath).toBeUndefined();
    });
});

describe('prepareWorkspace — env passthrough', () => {
    let workspace: Workspace | undefined;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
    });

    it('passes explicit env vars through to sandbox', async () => {
        workspace = await prepareWorkspace({
            agent: 'claude',
            env: { MY_API_KEY: 'secret123' },
        });

        const result = await workspace.exec('echo $MY_API_KEY');
        expect(result.stdout.trim()).toBe('secret123');
    });
});

describe('linkPathsFromHostHome', () => {
    let sandboxHome: string;
    let fakeHome: string;
    const originalHome = process.env.HOME;

    afterEach(async () => {
        process.env.HOME = originalHome;
        if (sandboxHome) await fs.remove(sandboxHome).catch(() => {});
        if (fakeHome) await fs.remove(fakeHome).catch(() => {});
    });

    it('symlinks an existing host HOME path into sandbox HOME', async () => {
        fakeHome = path.join(os.tmpdir(), `pg-linkfrom-src-${Math.random().toString(36).slice(2)}`);
        sandboxHome = path.join(os.tmpdir(), `pg-linkfrom-dst-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fakeHome, 'Library', 'Keychains'));
        await fs.writeFile(path.join(fakeHome, 'Library', 'Keychains', 'login.keychain-db'), 'fake-db');
        await fs.ensureDir(sandboxHome);

        process.env.HOME = fakeHome;
        await linkPathsFromHostHome(['Library/Keychains'], sandboxHome);

        const dest = path.join(sandboxHome, 'Library', 'Keychains');
        const stat = await fs.lstat(dest);
        expect(stat.isSymbolicLink()).toBe(true);
        expect(await fs.readlink(dest)).toBe(path.join(fakeHome, 'Library', 'Keychains'));
        // Reading through the symlink resolves to the host file content.
        expect(await fs.readFile(path.join(dest, 'login.keychain-db'), 'utf8')).toBe('fake-db');
    });

    it('silently skips paths that do not exist on host', async () => {
        fakeHome = path.join(os.tmpdir(), `pg-linkfrom-src-${Math.random().toString(36).slice(2)}`);
        sandboxHome = path.join(os.tmpdir(), `pg-linkfrom-dst-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fakeHome);
        await fs.ensureDir(sandboxHome);

        process.env.HOME = fakeHome;
        await linkPathsFromHostHome(['Library/Keychains', '.nonexistent'], sandboxHome);

        expect(await fs.pathExists(path.join(sandboxHome, 'Library', 'Keychains'))).toBe(false);
        expect(await fs.pathExists(path.join(sandboxHome, '.nonexistent'))).toBe(false);
    });

    it('does not dereference the source (creates symlink, not copy)', async () => {
        fakeHome = path.join(os.tmpdir(), `pg-linkfrom-src-${Math.random().toString(36).slice(2)}`);
        sandboxHome = path.join(os.tmpdir(), `pg-linkfrom-dst-${Math.random().toString(36).slice(2)}`);
        const srcFile = path.join(fakeHome, 'creds', 'secret.txt');
        await fs.ensureDir(path.dirname(srcFile));
        await fs.writeFile(srcFile, 'v1');
        await fs.ensureDir(sandboxHome);

        process.env.HOME = fakeHome;
        await linkPathsFromHostHome(['creds'], sandboxHome);

        // Mutating the host source should be visible through the symlink.
        await fs.writeFile(srcFile, 'v2');
        const dst = path.join(sandboxHome, 'creds', 'secret.txt');
        expect(await fs.readFile(dst, 'utf8')).toBe('v2');
    });
});

describe('prepareWorkspace — copyFromHome', () => {
    let workspace: Workspace | undefined;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
    });

    it('passes copyFromHome through to sandbox', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fakeHome);
        await fs.writeFile(path.join(fakeHome, '.gitconfig'), '[user]\nname = Test');

        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            workspace = await prepareWorkspace({
                agent: 'claude',
                copyFromHome: ['.gitconfig'],
            });

            // The sandbox HOME should have the file
            const result = await workspace.exec('cat $HOME/.gitconfig');
            expect(result.stdout).toContain('[user]');
        } finally {
            process.env.HOME = originalHome;
            await fs.remove(fakeHome);
        }
    });
});

describe('prepareWorkspace — codex auth fallback', () => {
    let workspace: Workspace | undefined;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
    });

    it('copies host codex auth cache into isolated HOME when no OPENAI_API_KEY is set', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-codex-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fakeHome, '.codex'));
        await fs.writeFile(path.join(fakeHome, '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}');

        const originalHome = process.env.HOME;
        const originalOpenAIKey = process.env.OPENAI_API_KEY;
        process.env.HOME = fakeHome;
        delete process.env.OPENAI_API_KEY;

        try {
            workspace = await prepareWorkspace({ agent: 'codex' });

            const result = await workspace.exec('cat $HOME/.codex/auth.json');
            expect(result.stdout.trim()).toBe('{"auth_mode":"chatgpt"}');
            expect(result.exitCode).toBe(0);
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            if (originalOpenAIKey === undefined) {
                delete process.env.OPENAI_API_KEY;
            } else {
                process.env.OPENAI_API_KEY = originalOpenAIKey;
            }
            await fs.remove(fakeHome);
        }
    });
});

describe('prepareWorkspace — always isolated', () => {
    let workspace: Workspace | undefined;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
    });

    it('exec uses isolated HOME from sandbox', async () => {
        workspace = await prepareWorkspace({ agent: 'claude' });

        const result = await workspace.exec('echo HOME=$HOME');
        expect(result.stdout.trim()).toContain('pathgrade-');
        expect(result.stdout.trim()).toContain('/home');
    });

    it('exec blocks arbitrary host env vars', async () => {
        process.env.SECRET_LEAK_PW_TEST = 'should-not-appear';
        try {
            workspace = await prepareWorkspace({ agent: 'claude' });

            const result = await workspace.exec('echo ${SECRET_LEAK_PW_TEST:-unset}');
            expect(result.stdout.trim()).toBe('unset');
        } finally {
            delete process.env.SECRET_LEAK_PW_TEST;
        }
    });
});

describe('prepareWorkspace — skillDir', () => {
    let workspace: Workspace | undefined;
    let fixtureDir: string;

    afterEach(async () => {
        if (workspace) { await workspace.dispose(); workspace = undefined; }
        if (fixtureDir) await fs.remove(fixtureDir).catch(() => {});
    });

    it('stages skill to native discovery path for claude', async () => {
        fixtureDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`);
        const skillDir = path.join(fixtureDir, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');

        workspace = await prepareWorkspace({
            agent: 'claude',
            skillDir,
        });

        const staged = path.join(workspace.path, '.claude', 'skills', 'my-skill', 'SKILL.md');
        expect(await fs.pathExists(staged)).toBe(true);
    });

    it('does not generate CLAUDE.md or AGENTS.md', async () => {
        fixtureDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`);
        const skillDir = path.join(fixtureDir, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');

        workspace = await prepareWorkspace({
            agent: 'claude',
            skillDir,
        });

        expect(await fs.pathExists(path.join(workspace.path, 'CLAUDE.md'))).toBe(false);
        expect(await fs.pathExists(path.join(workspace.path, 'AGENTS.md'))).toBe(false);
    });

    it('does nothing when no skillDir is provided', async () => {
        workspace = await prepareWorkspace({ agent: 'claude' });

        expect(await fs.pathExists(path.join(workspace.path, '.claude', 'skills'))).toBe(false);
    });
});

describe('prepareWorkspace', () => {
    let workspace: Workspace | undefined;

    afterEach(async () => {
        if (workspace) {
            await workspace.dispose();
            workspace = undefined;
        }
    });

    it('dispose is idempotent — calling twice does not throw', async () => {
        workspace = await prepareWorkspace({ agent: 'claude' });
        const wsPath = workspace.path;

        await workspace.dispose();
        await workspace.dispose(); // should not throw

        expect(await fs.pathExists(wsPath)).toBe(false);
        workspace = undefined; // already disposed
    });

    it('exec sets workspace env vars on child process', async () => {
        workspace = await prepareWorkspace({ agent: 'claude' });

        const result = await workspace.exec('echo $TMPDIR');
        expect(result.stdout.trim()).toContain('pathgrade-');
        expect(result.stdout.trim()).toContain('/tmp');
        expect(result.exitCode).toBe(0);
    });

    it('copies fixture directory via workspace string', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'hello.txt'), 'world');

        try {
            workspace = await prepareWorkspace({
                agent: 'claude',
                workspace: fixtureDir,
            });

            expect(await fs.pathExists(path.join(workspace.path, 'hello.txt'))).toBe(true);
            expect(await fs.readFile(path.join(workspace.path, 'hello.txt'), 'utf-8')).toBe('world');

            const result = await workspace.exec('pwd');
            const expected = await fs.realpath(workspace.path);
            expect(result.stdout.trim()).toBe(expected);
            expect(result.exitCode).toBe(0);

            const wsPath = workspace.path;
            await workspace.dispose();
            workspace = undefined;
            expect(await fs.pathExists(wsPath)).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });
});
