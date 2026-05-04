import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { createSandbox } from '../src/providers/sandbox.js';

describe('createSandbox', () => {
    const sandboxes: string[] = [];

    afterEach(async () => {
        for (const dir of sandboxes) {
            await fs.remove(dir).catch(() => {});
        }
        sandboxes.length = 0;
    });

    it('creates workspace/, home/, tmp/ directories', async () => {
        const sandbox = await createSandbox({ agent: 'claude' });
        sandboxes.push(sandbox.rootDir);

        expect(await fs.pathExists(sandbox.workspacePath)).toBe(true);
        expect(await fs.pathExists(sandbox.homePath)).toBe(true);
        expect(await fs.pathExists(path.join(sandbox.rootDir, 'tmp'))).toBe(true);

        // Paths are correct children of rootDir
        expect(sandbox.workspacePath).toBe(path.join(sandbox.rootDir, 'workspace'));
        expect(sandbox.homePath).toBe(path.join(sandbox.rootDir, 'home'));
    });

    it('env includes HOME pointing to home dir', async () => {
        const sandbox = await createSandbox({ agent: 'claude' });
        sandboxes.push(sandbox.rootDir);

        expect(sandbox.env.HOME).toBe(sandbox.homePath);
    });

    it('env includes TMPDIR, TMP, TEMP pointing to tmp dir', async () => {
        const sandbox = await createSandbox({ agent: 'claude' });
        sandboxes.push(sandbox.rootDir);

        const tmpPath = path.join(sandbox.rootDir, 'tmp');
        expect(sandbox.env.TMPDIR).toBe(tmpPath);
        expect(sandbox.env.TMP).toBe(tmpPath);
        expect(sandbox.env.TEMP).toBe(tmpPath);
    });

    it('env includes SAFE_HOST_VARS from process.env', async () => {
        const originalPath = process.env.PATH;
        const originalShell = process.env.SHELL;
        process.env.PATH = '/usr/bin:/bin';
        process.env.SHELL = '/bin/zsh';

        try {
            const sandbox = await createSandbox({ agent: 'claude' });
            sandboxes.push(sandbox.rootDir);

            expect(sandbox.env.PATH).toBe('/usr/bin:/bin');
            expect(sandbox.env.SHELL).toBe('/bin/zsh');
        } finally {
            if (originalPath !== undefined) process.env.PATH = originalPath;
            else delete process.env.PATH;
            if (originalShell !== undefined) process.env.SHELL = originalShell;
            else delete process.env.SHELL;
        }
    });

    it('env does NOT include arbitrary host vars', async () => {
        process.env.SECRET_LEAK_TEST = 'should-not-appear';
        try {
            const sandbox = await createSandbox({ agent: 'claude' });
            sandboxes.push(sandbox.rootDir);

            expect(sandbox.env.SECRET_LEAK_TEST).toBeUndefined();
        } finally {
            delete process.env.SECRET_LEAK_TEST;
        }
    });

    it('explicit env overrides take precedence over defaults', async () => {
        const sandbox = await createSandbox({
            agent: 'claude',
            env: { HOME: '/custom/home', MY_VAR: 'hello' },
        });
        sandboxes.push(sandbox.rootDir);

        expect(sandbox.env.HOME).toBe('/custom/home');
        expect(sandbox.env.MY_VAR).toBe('hello');
        // TMPDIR still set from defaults
        expect(sandbox.env.TMPDIR).toBe(path.join(sandbox.rootDir, 'tmp'));
    });

    it('copies fixture directory contents to workspace when workspace is provided', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'hello.txt'), 'world');
        await fs.ensureDir(path.join(fixtureDir, 'subdir'));
        await fs.writeFile(path.join(fixtureDir, 'subdir', 'nested.txt'), 'deep');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.readFile(path.join(sandbox.workspacePath, 'hello.txt'), 'utf-8')).toBe('world');
            expect(await fs.readFile(path.join(sandbox.workspacePath, 'subdir', 'nested.txt'), 'utf-8')).toBe('deep');
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('filters default junk directories and files from workspace copies', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, 'src', 'vendor', 'node_modules', 'left-pad'));
        await fs.ensureDir(path.join(fixtureDir, '.git'));
        await fs.ensureDir(path.join(fixtureDir, 'build', 'dist'));
        await fs.ensureDir(path.join(fixtureDir, 'python', '__pycache__'));
        await fs.ensureDir(path.join(fixtureDir, 'nested'));
        await fs.writeFile(path.join(fixtureDir, 'keep.ts'), 'export const keep = true;');
        await fs.writeFile(path.join(fixtureDir, 'src', 'vendor', 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(fixtureDir, '.git', 'HEAD'), 'ref: refs/heads/main');
        await fs.writeFile(path.join(fixtureDir, 'build', 'dist', 'bundle.js'), 'bundle');
        await fs.writeFile(path.join(fixtureDir, 'python', '__pycache__', 'app.pyc'), 'compiled');
        await fs.writeFile(path.join(fixtureDir, '.DS_Store'), 'mac');
        await fs.writeFile(path.join(fixtureDir, 'npm-debug.log.12345'), 'debug');
        await fs.writeFile(path.join(fixtureDir, 'nested', 'yarn-error.log'), 'error');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'keep.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, '.git'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'src', 'vendor', 'node_modules'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'build', 'dist'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'python', '__pycache__'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, '.DS_Store'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'npm-debug.log.12345'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'nested', 'yarn-error.log'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('allows a workspace copy to succeed when every entry is filtered', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'left-pad'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(fixtureDir, '.DS_Store'), 'mac');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.readdir(sandbox.workspacePath)).toEqual([]);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('replaces the default ignore list when copyIgnore is provided', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'left-pad'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(fixtureDir, 'custom.tmp'), 'remove me');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: ['custom.tmp'],
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'custom.tmp'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('allows an empty workspace result when custom copyIgnore filters every entry', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, 'logs'));
        await fs.writeFile(path.join(fixtureDir, 'logs', 'agent.log'), 'noise');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: ['logs'],
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.readdir(sandbox.workspacePath)).toEqual([]);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('workspace is empty dir when no fixture provided', async () => {
        const sandbox = await createSandbox({ agent: 'claude' });
        sandboxes.push(sandbox.rootDir);

        const contents = await fs.readdir(sandbox.workspacePath);
        expect(contents).toEqual([]);
    });

    it('skillDir for claude copies skill to .claude/skills/{name}/', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.ensureDir(path.join(skillDir, 'lib'));
        await fs.writeFile(path.join(skillDir, 'lib', 'helper.ts'), 'export {}');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(staged, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
            expect(await fs.readFile(path.join(staged, 'lib', 'helper.ts'), 'utf-8')).toBe('export {}');
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('skillDir for codex copies skill to .agents/skills/{name}/', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');

        try {
            const sandbox = await createSandbox({ agent: 'codex', skillDir });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.agents', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(staged, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('skillDir for claude also copies skill to .agents/skills/{name}/ (dual path)', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.ensureDir(path.join(skillDir, 'lib'));
        await fs.writeFile(path.join(skillDir, 'lib', 'helper.ts'), 'export {}');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            // Primary path
            const primary = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(primary, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
            expect(await fs.readFile(path.join(primary, 'lib', 'helper.ts'), 'utf-8')).toBe('export {}');

            // Secondary path — identical contents
            const secondary = path.join(sandbox.workspacePath, '.agents', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(secondary, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
            expect(await fs.readFile(path.join(secondary, 'lib', 'helper.ts'), 'utf-8')).toBe('export {}');
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('skillDir for codex also copies skill to .claude/skills/{name}/ (dual path)', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.ensureDir(path.join(skillDir, 'scripts'));
        await fs.writeFile(path.join(skillDir, 'scripts', 'run.sh'), '#!/bin/bash');

        try {
            const sandbox = await createSandbox({ agent: 'codex', skillDir });
            sandboxes.push(sandbox.rootDir);

            // Primary path
            const primary = path.join(sandbox.workspacePath, '.agents', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(primary, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
            expect(await fs.readFile(path.join(primary, 'scripts', 'run.sh'), 'utf-8')).toBe('#!/bin/bash');

            // Secondary path — identical contents
            const secondary = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.readFile(path.join(secondary, 'SKILL.md'), 'utf-8')).toBe('# My Skill');
            expect(await fs.readFile(path.join(secondary, 'scripts', 'run.sh'), 'utf-8')).toBe('#!/bin/bash');
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    describe('cursor rules staging', () => {
        async function makeSkill(name: string, body: string): Promise<string> {
            const root = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`);
            const skillDir = path.join(root, name);
            await fs.ensureDir(skillDir);
            await fs.writeFile(path.join(skillDir, 'SKILL.md'), body);
            return skillDir;
        }

        it.each(['claude', 'codex', 'cursor'] as const)(
            'emits .cursor/rules/<skill>.mdc for agent %s regardless of agent',
            async (agent) => {
                const skillDir = await makeSkill('my-skill', '---\ndescription: Does things\n---\n\n# My Skill\n\nBody.');
                try {
                    const sandbox = await createSandbox({ agent, skillDir });
                    sandboxes.push(sandbox.rootDir);

                    const rulePath = path.join(sandbox.workspacePath, '.cursor', 'rules', 'my-skill.mdc');
                    expect(await fs.pathExists(rulePath)).toBe(true);
                } finally {
                    await fs.remove(path.dirname(skillDir));
                }
            },
        );

        it('rule file starts with alwaysApply: true frontmatter and a description', async () => {
            const skillDir = await makeSkill(
                'my-skill',
                '---\ndescription: Does things reliably\n---\n\n# My Skill\n\nBody.',
            );
            try {
                const sandbox = await createSandbox({ agent: 'cursor', skillDir });
                sandboxes.push(sandbox.rootDir);

                const rule = await fs.readFile(
                    path.join(sandbox.workspacePath, '.cursor', 'rules', 'my-skill.mdc'),
                    'utf8',
                );
                expect(rule.startsWith('---\n')).toBe(true);
                const frontmatter = rule.slice(4, rule.indexOf('\n---\n', 4));
                expect(frontmatter).toMatch(/^alwaysApply:\s*true$/m);
                expect(frontmatter).toMatch(/^description:\s*.+$/m);
            } finally {
                await fs.remove(path.dirname(skillDir));
            }
        });

        it('rule body inlines the SKILL.md content', async () => {
            const skillBody = '# My Skill\n\nDo the thing carefully.\n\n## Details\n\nMore.\n';
            const skillDir = await makeSkill(
                'my-skill',
                `---\ndescription: Does things\n---\n\n${skillBody}`,
            );
            try {
                const sandbox = await createSandbox({ agent: 'cursor', skillDir });
                sandboxes.push(sandbox.rootDir);

                const rule = await fs.readFile(
                    path.join(sandbox.workspacePath, '.cursor', 'rules', 'my-skill.mdc'),
                    'utf8',
                );
                // Body (after the closing frontmatter delimiter) must contain
                // the SKILL.md body verbatim so Cursor's rule loader applies
                // the rule — pointer-only references are not honored.
                const bodyStart = rule.indexOf('\n---\n', 4) + '\n---\n'.length;
                const ruleBody = rule.slice(bodyStart);
                expect(ruleBody).toContain('# My Skill');
                expect(ruleBody).toContain('Do the thing carefully.');
                expect(ruleBody).toContain('## Details');
            } finally {
                await fs.remove(path.dirname(skillDir));
            }
        });

        it('derives a fallback description when SKILL.md has no frontmatter description', async () => {
            const skillDir = await makeSkill('bare-skill', '# Bare\n\nNo frontmatter here.\n');
            try {
                const sandbox = await createSandbox({ agent: 'cursor', skillDir });
                sandboxes.push(sandbox.rootDir);

                const rule = await fs.readFile(
                    path.join(sandbox.workspacePath, '.cursor', 'rules', 'bare-skill.mdc'),
                    'utf8',
                );
                const frontmatter = rule.slice(4, rule.indexOf('\n---\n', 4));
                expect(frontmatter).toMatch(/^description:\s*.+$/m);
            } finally {
                await fs.remove(path.dirname(skillDir));
            }
        });

        it('skips .cursor/rules emission when no SKILL.md is present', async () => {
            const root = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`);
            const skillDir = path.join(root, 'no-manifest');
            await fs.ensureDir(skillDir);
            await fs.writeFile(path.join(skillDir, 'readme.md'), 'nothing useful');
            try {
                const sandbox = await createSandbox({ agent: 'cursor', skillDir });
                sandboxes.push(sandbox.rootDir);

                const rulesDir = path.join(sandbox.workspacePath, '.cursor', 'rules');
                expect(await fs.pathExists(rulesDir)).toBe(false);
            } finally {
                await fs.remove(root);
            }
        });
    });

    it('skillDir creates HOME symlinks for both .claude/skills and .agents/skills', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            // Both HOME symlinks should exist
            const claudeLink = path.join(sandbox.homePath, '.claude', 'skills');
            const agentsLink = path.join(sandbox.homePath, '.agents', 'skills');

            expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
            expect((await fs.lstat(agentsLink)).isSymbolicLink()).toBe(true);

            expect(await fs.readlink(claudeLink)).toBe(path.join(sandbox.workspacePath, '.claude', 'skills'));
            expect(await fs.readlink(agentsLink)).toBe(path.join(sandbox.workspacePath, '.agents', 'skills'));
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('skillDir excludes test/ directory from the copy', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.ensureDir(path.join(skillDir, 'test'));
        await fs.writeFile(path.join(skillDir, 'test', 'my-skill.eval.ts'), 'test code');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.pathExists(path.join(staged, 'SKILL.md'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'test'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('applies the default junk filtering to skillDir while preserving test exclusion', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(path.join(skillDir, 'lib'));
        await fs.ensureDir(path.join(skillDir, 'nested', 'dist'));
        await fs.ensureDir(path.join(skillDir, 'node_modules', 'left-pad'));
        await fs.ensureDir(path.join(skillDir, 'test'));
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.writeFile(path.join(skillDir, 'lib', 'helper.ts'), 'export const helper = true;');
        await fs.writeFile(path.join(skillDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(skillDir, 'nested', 'dist', 'bundle.js'), 'bundle');
        await fs.writeFile(path.join(skillDir, '.DS_Store'), 'mac');
        await fs.writeFile(path.join(skillDir, 'test', 'my-skill.eval.ts'), 'test code');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.pathExists(path.join(staged, 'SKILL.md'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'lib', 'helper.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'node_modules'))).toBe(false);
            expect(await fs.pathExists(path.join(staged, 'nested', 'dist'))).toBe(false);
            expect(await fs.pathExists(path.join(staged, '.DS_Store'))).toBe(false);
            expect(await fs.pathExists(path.join(staged, 'test'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('disables configurable filtering with copyIgnore: [] but still excludes skill test directories', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(path.join(skillDir, 'node_modules', 'left-pad'));
        await fs.ensureDir(path.join(skillDir, 'test'));
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.writeFile(path.join(skillDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {};');
        await fs.writeFile(path.join(skillDir, 'test', 'my-skill.eval.ts'), 'test code');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                skillDir,
                copyIgnore: [],
            });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.pathExists(path.join(staged, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'test'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('ignores odd copyIgnore patterns that do not match while still applying valid ones', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, 'nested'));
        await fs.writeFile(path.join(fixtureDir, 'nested', 'keep.txt'), 'keep');
        await fs.writeFile(path.join(fixtureDir, 'nested', 'custom.log'), 'drop');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: ['[', 'custom.log'],
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'nested', 'keep.txt'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'nested', 'custom.log'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('creates symlink from home/.claude/skills/ to workspace/.claude/skills/ when it exists', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            const homeLink = path.join(sandbox.homePath, '.claude', 'skills');
            const stat = await fs.lstat(homeLink);
            expect(stat.isSymbolicLink()).toBe(true);

            const target = await fs.readlink(homeLink);
            expect(target).toBe(path.join(sandbox.workspacePath, '.claude', 'skills'));
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('creates symlink from home/.agents/skills/ to workspace/.agents/skills/ when it exists', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-fixture-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fixtureDir, '.agents', 'skills', 'ck-shared'));
        await fs.writeFile(path.join(fixtureDir, '.agents', 'skills', 'ck-shared', 'SKILL.md'), '# Shared');

        try {
            const sandbox = await createSandbox({ agent: 'codex', workspace: fixtureDir });
            sandboxes.push(sandbox.rootDir);

            const homeLink = path.join(sandbox.homePath, '.agents', 'skills');
            const stat = await fs.lstat(homeLink);
            expect(stat.isSymbolicLink()).toBe(true);

            const target = await fs.readlink(homeLink);
            expect(target).toBe(path.join(sandbox.workspacePath, '.agents', 'skills'));
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('does NOT create symlinks when skill directories do not exist in workspace', async () => {
        const sandbox = await createSandbox({ agent: 'claude' });
        sandboxes.push(sandbox.rootDir);

        expect(await fs.pathExists(path.join(sandbox.homePath, '.claude', 'skills'))).toBe(false);
        expect(await fs.pathExists(path.join(sandbox.homePath, '.agents', 'skills'))).toBe(false);
    });

    it('copyFromHome copies existing file from host HOME into sandbox HOME', async () => {
        // Create a fake host HOME with a file in it
        const fakeHome = path.join(os.tmpdir(), `pg-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fakeHome);
        await fs.writeFile(path.join(fakeHome, '.npmrc'), 'registry=https://registry.example.com');

        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                copyFromHome: ['.npmrc'],
            });
            sandboxes.push(sandbox.rootDir);

            const copied = path.join(sandbox.homePath, '.npmrc');
            expect(await fs.pathExists(copied)).toBe(true);
            expect(await fs.readFile(copied, 'utf-8')).toBe('registry=https://registry.example.com');
        } finally {
            process.env.HOME = originalHome;
            await fs.remove(fakeHome);
        }
    });

    it('copyFromHome silently skips paths that do not exist on host', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fakeHome);
        // No files created in fakeHome

        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                copyFromHome: ['.nonexistent-file', '.missing-dir/'],
            });
            sandboxes.push(sandbox.rootDir);

            // Should not throw, and nothing should be copied
            expect(await fs.pathExists(path.join(sandbox.homePath, '.nonexistent-file'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.homePath, '.missing-dir'))).toBe(false);
        } finally {
            process.env.HOME = originalHome;
            await fs.remove(fakeHome);
        }
    });

    it('filters default junk directories from workspace copy', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-filter-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        // Regular files that should be copied
        await fs.writeFile(path.join(fixtureDir, 'index.ts'), 'console.log("hello")');
        await fs.writeFile(path.join(fixtureDir, 'README.md'), '# Project');
        // Junk that should be filtered
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'some-pkg'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {}');
        await fs.ensureDir(path.join(fixtureDir, '.git', 'objects'));
        await fs.writeFile(path.join(fixtureDir, '.git', 'HEAD'), 'ref: refs/heads/main');
        await fs.ensureDir(path.join(fixtureDir, 'dist'));
        await fs.writeFile(path.join(fixtureDir, 'dist', 'bundle.js'), '// built');
        await fs.writeFile(path.join(fixtureDir, '.DS_Store'), '\x00\x00');
        await fs.writeFile(path.join(fixtureDir, 'npm-debug.log'), 'debug output');

        try {
            const sandbox = await createSandbox({ agent: 'claude', workspace: fixtureDir });
            sandboxes.push(sandbox.rootDir);

            // Regular files should be present
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'index.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'README.md'))).toBe(true);

            // Junk should be absent
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'node_modules'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, '.git'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'dist'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, '.DS_Store'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'npm-debug.log'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('filters nested node_modules at any depth', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-nested-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'app.ts'), 'export {}');
        // Nested node_modules
        await fs.ensureDir(path.join(fixtureDir, 'packages', 'lib', 'node_modules', 'dep'));
        await fs.writeFile(path.join(fixtureDir, 'packages', 'lib', 'node_modules', 'dep', 'index.js'), '');
        await fs.writeFile(path.join(fixtureDir, 'packages', 'lib', 'src.ts'), 'export {}');

        try {
            const sandbox = await createSandbox({ agent: 'claude', workspace: fixtureDir });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'app.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'packages', 'lib', 'src.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'packages', 'lib', 'node_modules'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('filters junk from skill directory copies', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-filter-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        // Skill files that should be copied
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Test');
        await fs.writeFile(path.join(skillDir, 'helper.ts'), 'export {}');
        // Junk that should be filtered
        await fs.ensureDir(path.join(skillDir, 'node_modules', 'dep'));
        await fs.writeFile(path.join(skillDir, 'node_modules', 'dep', 'index.js'), '');
        await fs.ensureDir(path.join(skillDir, '.git'));
        await fs.writeFile(path.join(skillDir, '.git', 'HEAD'), 'ref: refs/heads/main');
        await fs.writeFile(path.join(skillDir, '.DS_Store'), '\x00');

        try {
            const sandbox = await createSandbox({ agent: 'claude', skillDir });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            // Skill files should be present
            expect(await fs.pathExists(path.join(staged, 'SKILL.md'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'helper.ts'))).toBe(true);

            // Junk should be absent
            expect(await fs.pathExists(path.join(staged, 'node_modules'))).toBe(false);
            expect(await fs.pathExists(path.join(staged, '.git'))).toBe(false);
            expect(await fs.pathExists(path.join(staged, '.DS_Store'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('uses custom copyIgnore when provided, replacing defaults', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-custom-ignore-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        // Files
        await fs.writeFile(path.join(fixtureDir, 'app.ts'), 'export {}');
        await fs.writeFile(path.join(fixtureDir, 'debug.log'), 'debug');
        // Directories that default filter would catch
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'pkg'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'pkg', 'index.js'), '');
        // Custom filter target
        await fs.ensureDir(path.join(fixtureDir, 'build'));
        await fs.writeFile(path.join(fixtureDir, 'build', 'out.js'), '');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: ['*.log', 'build'],
            });
            sandboxes.push(sandbox.rootDir);

            // Regular files should be present
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'app.ts'))).toBe(true);
            // node_modules should be present (custom list replaces defaults)
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'node_modules'))).toBe(true);
            // Custom patterns should filter
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'debug.log'))).toBe(false);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'build'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('disables filtering when copyIgnore is empty array', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-no-filter-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'index.ts'), 'export {}');
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'pkg'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'pkg', 'index.js'), '');
        await fs.ensureDir(path.join(fixtureDir, '.git'));
        await fs.writeFile(path.join(fixtureDir, '.git', 'HEAD'), 'ref: refs/heads/main');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: [],
            });
            sandboxes.push(sandbox.rootDir);

            // Everything should be present since filtering is disabled
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'index.ts'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'node_modules'))).toBe(true);
            expect(await fs.pathExists(path.join(sandbox.workspacePath, '.git'))).toBe(true);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('handles invalid glob patterns in copyIgnore gracefully', async () => {
        const fixtureDir = path.join(os.tmpdir(), `pg-invalid-glob-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(fixtureDir);
        await fs.writeFile(path.join(fixtureDir, 'app.ts'), 'export {}');
        await fs.ensureDir(path.join(fixtureDir, 'node_modules', 'pkg'));
        await fs.writeFile(path.join(fixtureDir, 'node_modules', 'pkg', 'index.js'), '');

        try {
            // Should not throw, invalid patterns are silently ignored
            const sandbox = await createSandbox({
                agent: 'claude',
                workspace: fixtureDir,
                copyIgnore: ['node_modules', '[invalid'],
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'app.ts'))).toBe(true);
            // Valid pattern still works
            expect(await fs.pathExists(path.join(sandbox.workspacePath, 'node_modules'))).toBe(false);
        } finally {
            await fs.remove(fixtureDir);
        }
    });

    it('applies custom copyIgnore to skill copies too', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-custom-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Test');
        await fs.ensureDir(path.join(skillDir, 'fixtures'));
        await fs.writeFile(path.join(skillDir, 'fixtures', 'data.json'), '{}');
        await fs.ensureDir(path.join(skillDir, 'temp'));
        await fs.writeFile(path.join(skillDir, 'temp', 'junk.txt'), 'junk');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                skillDir,
                copyIgnore: ['temp'],
            });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.pathExists(path.join(staged, 'SKILL.md'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'fixtures', 'data.json'))).toBe(true);
            expect(await fs.pathExists(path.join(staged, 'temp'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('skillDir still excludes test/ even with custom copyIgnore', async () => {
        const skillDir = path.join(os.tmpdir(), `pg-skill-test-filter-${Math.random().toString(36).slice(2)}`, 'my-skill');
        await fs.ensureDir(skillDir);
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');
        await fs.ensureDir(path.join(skillDir, 'test'));
        await fs.writeFile(path.join(skillDir, 'test', 'my-skill.eval.ts'), 'test code');

        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                skillDir,
                copyIgnore: [],  // disable copy filter
            });
            sandboxes.push(sandbox.rootDir);

            const staged = path.join(sandbox.workspacePath, '.claude', 'skills', 'my-skill');
            expect(await fs.pathExists(path.join(staged, 'SKILL.md'))).toBe(true);
            // test/ should still be excluded even with empty copyIgnore
            expect(await fs.pathExists(path.join(staged, 'test'))).toBe(false);
        } finally {
            await fs.remove(path.dirname(skillDir));
        }
    });

    it('copyFromHome copies directory subtree preserving structure', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fakeHome, '.config', 'claude'));
        await fs.writeFile(path.join(fakeHome, '.config', 'claude', 'auth.json'), '{"token":"abc"}');
        await fs.writeFile(path.join(fakeHome, '.config', 'claude', 'settings.json'), '{}');

        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                copyFromHome: ['.config/claude/'],
            });
            sandboxes.push(sandbox.rootDir);

            const copiedDir = path.join(sandbox.homePath, '.config', 'claude');
            expect(await fs.readFile(path.join(copiedDir, 'auth.json'), 'utf-8')).toBe('{"token":"abc"}');
            expect(await fs.readFile(path.join(copiedDir, 'settings.json'), 'utf-8')).toBe('{}');
        } finally {
            process.env.HOME = originalHome;
            await fs.remove(fakeHome);
        }
    });

    it('does not apply copyIgnore to copyFromHome paths', async () => {
        const fakeHome = path.join(os.tmpdir(), `pg-home-${Math.random().toString(36).slice(2)}`);
        await fs.ensureDir(path.join(fakeHome, '.config'));
        await fs.writeFile(path.join(fakeHome, '.config', 'settings.json'), '{"copied":true}');

        const originalHome = process.env.HOME;
        process.env.HOME = fakeHome;
        try {
            const sandbox = await createSandbox({
                agent: 'claude',
                copyFromHome: ['.config/settings.json'],
                copyIgnore: ['settings.json'],
            });
            sandboxes.push(sandbox.rootDir);

            expect(await fs.readFile(path.join(sandbox.homePath, '.config', 'settings.json'), 'utf-8')).toBe('{"copied":true}');
        } finally {
            process.env.HOME = originalHome;
            await fs.remove(fakeHome);
        }
    });
});
