import { describe, it, expect, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fsExtra from 'fs-extra';
import { LocalProvider } from '../src/providers/local';
import { TrialRuntime } from '../src/types';

describe('LocalProvider host-auth passthrough', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        for (const dir of tempDirs) {
            if (await fsExtra.pathExists(dir)) {
                await fsExtra.remove(dir);
            }
        }
        tempDirs.length = 0;
    });

    async function createTaskDir(): Promise<string> {
        const taskDir = path.join(os.tmpdir(), `pathgrade-test-${Date.now()}`);
        await fsExtra.ensureDir(taskDir);
        await fsExtra.writeFile(path.join(taskDir, 'task.toml'), 'name = "test"');
        tempDirs.push(taskDir);
        return taskDir;
    }

    const baseOpts = {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
    };

    async function createSkillDir(): Promise<string> {
        const skillDir = path.join(os.tmpdir(), `pathgrade-skill-${Date.now()}`);
        await fsExtra.ensureDir(skillDir);
        await fsExtra.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
        tempDirs.push(skillDir);
        return skillDir;
    }

    async function createNamedSkillDir(skillName: string): Promise<string> {
        const skillDir = path.join(os.tmpdir(), `pathgrade-skill-${Date.now()}-${skillName}`);
        await fsExtra.ensureDir(skillDir);
        await fsExtra.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Test skill\n---\n`);
        tempDirs.push(skillDir);
        return skillDir;
    }

    it('preserves real HOME when authMode is host', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], { ...baseOpts, authMode: 'host' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeUndefined();
        expect(runtime.env.TMPDIR).toBeTruthy();
        expect(runtime.paths?.home).toBe(process.env.HOME || os.homedir());
        expect(runtime.paths?.xdg).toBeUndefined();
        await provider.cleanup(runtime);
    });

    it('overrides HOME when authMode is isolated', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], { ...baseOpts, authMode: 'isolated' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        expect(runtime.paths?.xdg).toBeTruthy();
        await provider.cleanup(runtime);
    });

    it('materializes Codex bootstrap files in host auth mode', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const skillDir = await createSkillDir();
        const runtime = await provider.setup(
            taskDir,
            [skillDir],
            { ...baseOpts, authMode: 'host' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(await fsExtra.pathExists(path.join(runtime.workspacePath, '.pathgrade', 'skills', path.basename(skillDir), 'SKILL.md'))).toBe(true);
        expect(await fsExtra.pathExists(path.join(runtime.workspacePath, 'AGENTS.md'))).toBe(true);
    });

    it('materializes Codex bootstrap files in isolated mode', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const skillDir = await createSkillDir();
        const runtime = await provider.setup(
            taskDir,
            [skillDir],
            { ...baseOpts, authMode: 'isolated' as const }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(await fsExtra.pathExists(path.join(runtime.workspacePath, '.pathgrade', 'skills', path.basename(skillDir), 'SKILL.md'))).toBe(true);
        expect(await fsExtra.pathExists(path.join(runtime.workspacePath, 'AGENTS.md'))).toBe(true);
    });

    it('creates a sanitized Codex auth home for host-auth Codex runs', async () => {
        const provider = new LocalProvider();
        const hostHome = path.join(os.tmpdir(), `pathgrade-host-home-${Date.now()}`);
        const taskDir = await createTaskDir();
        tempDirs.push(hostHome);

        await fsExtra.ensureDir(path.join(hostHome, '.codex'));
        await fsExtra.writeFile(path.join(hostHome, '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}');
        await fsExtra.writeFile(path.join(hostHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');

        vi.stubEnv('HOME', hostHome);

        const runtime = await provider.setup(
            taskDir,
            [],
            { ...baseOpts, authMode: 'host' as const },
            { PATHGRADE_CODEX_USE_HOST_AUTH: '1' }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(hostHome);
        expect(await fsExtra.pathExists(path.join(runtime.env.HOME!, '.codex', 'auth.json'))).toBe(true);
        expect(await fsExtra.pathExists(path.join(runtime.env.HOME!, '.codex', 'config.toml'))).toBe(false);
    });

    it('preserves ck-shared support files in sanitized Codex host-auth homes', async () => {
        const provider = new LocalProvider();
        const hostHome = path.join(os.tmpdir(), `pathgrade-host-home-${Date.now()}`);
        const taskDir = await createTaskDir();
        tempDirs.push(hostHome);

        const sharedScript = path.join(hostHome, '.agents', 'skills', 'ck-shared', 'scripts', 'load-ext.js');
        await fsExtra.ensureDir(path.dirname(sharedScript));
        await fsExtra.writeFile(sharedScript, 'console.log("ok");\n');

        vi.stubEnv('HOME', hostHome);

        const runtime = await provider.setup(
            taskDir,
            [],
            { ...baseOpts, authMode: 'host' as const },
            { PATHGRADE_CODEX_USE_HOST_AUTH: '1' }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(await fsExtra.pathExists(path.join(runtime.env.HOME!, '.agents', 'skills', 'ck-shared', 'scripts', 'load-ext.js'))).toBe(true);
        expect(await fsExtra.readFile(path.join(runtime.env.HOME!, '.agents', 'skills', 'ck-shared', 'scripts', 'load-ext.js'), 'utf8')).toBe('console.log("ok");\n');
    });

    it('stages supplied skills under their canonical skill names in sanitized Codex host-auth homes', async () => {
        const provider = new LocalProvider();
        const hostHome = path.join(os.tmpdir(), `pathgrade-host-home-${Date.now()}`);
        const taskDir = await createTaskDir();
        const skillDir = await createNamedSkillDir('ck-new');
        tempDirs.push(hostHome);

        vi.stubEnv('HOME', hostHome);

        const runtime = await provider.setup(
            taskDir,
            [skillDir],
            { ...baseOpts, authMode: 'host' as const },
            { PATHGRADE_CODEX_USE_HOST_AUTH: '1' }
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(await fsExtra.pathExists(path.join(runtime.env.HOME!, '.agents', 'skills', 'ck-new', 'SKILL.md'))).toBe(true);
    });

    it('defaults to isolated when authMode is omitted', async () => {
        const provider = new LocalProvider();
        const taskDir = await createTaskDir();
        const runtime = await provider.setup(
            taskDir, [], baseOpts
        ) as TrialRuntime;
        tempDirs.push(runtime.handle);

        expect(runtime.env.HOME).toBeTruthy();
        expect(runtime.env.HOME).not.toBe(process.env.HOME);
        await provider.cleanup(runtime);
    });
});
