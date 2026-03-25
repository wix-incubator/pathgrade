import { describe, it, expect, afterEach } from 'vitest';
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
