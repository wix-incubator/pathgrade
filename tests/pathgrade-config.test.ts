import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePathgradeConfig } from '../src/config/pathgrade.js';

function makeRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-config-'));
}

function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('resolvePathgradeConfig', () => {
    it('returns Pathgrade-owned defaults when no config file exists', async () => {
        const root = makeRepo();

        await expect(resolvePathgradeConfig({ cwd: root })).resolves.toEqual({
            runner: {
                adapter: 'vitest',
                args: [],
            },
            evals: {
                include: ['**/*.eval.ts'],
                exclude: expect.arrayContaining([
                    '.worktrees/**',
                    'worktrees/**',
                    '**/node_modules/**',
                    '**/fixtures/**',
                ]),
            },
            affected: {
                global: [],
            },
            diagnostics: false,
            verbose: false,
            ci: {},
        });
    });

    it('loads eval and affected settings from pathgrade.config.ts', async () => {
        const root = makeRepo();
        writeFile(root, 'pathgrade.config.ts', `
export default {
    evals: {
        include: ['cases/**/*.eval.ts'],
        exclude: ['cases/archive/**'],
    },
    affected: {
        global: ['package.json'],
    },
};
`);

        const config = await resolvePathgradeConfig({ cwd: root });

        expect(config.evals).toEqual({
            include: ['cases/**/*.eval.ts'],
            exclude: ['cases/archive/**'],
        });
        expect(config.affected.global).toEqual(['package.json']);
    });

    it('uses legacy Vitest plugin options as a compatibility fallback', async () => {
        const root = makeRepo();
        writeFile(root, 'vitest.config.ts', `
export default {
    plugins: [
        {
            name: 'pathgrade',
            __pathgradeOptions: {
                include: ['legacy/**/*.eval.ts'],
                exclude: ['legacy/skip/**'],
                affected: { global: ['yarn.lock'] },
            },
        },
    ],
};
`);

        const config = await resolvePathgradeConfig({ cwd: root });

        expect(config.evals).toEqual({
            include: ['legacy/**/*.eval.ts'],
            exclude: ['legacy/skip/**'],
        });
        expect(config.affected.global).toEqual(['yarn.lock']);
    });

    it('skips legacy Vitest plugin options in standalone mode', async () => {
        const root = makeRepo();
        writeFile(root, 'vitest.config.ts', `
export default {
    plugins: [{
        name: 'pathgrade',
        __pathgradeOptions: { include: ['legacy/**/*.eval.ts'] },
    }],
};
`);

        const resolved = await resolvePathgradeConfig({ cwd: root, standalone: true });

        expect(resolved.evals.include).toEqual(['**/*.eval.ts']);
    });

    it('prefers CLI overrides over pathgrade.config.ts and legacy Vitest fallback', async () => {
        const root = makeRepo();
        writeFile(root, 'vitest.config.ts', `
export default {
    plugins: [{
        name: 'pathgrade',
        __pathgradeOptions: {
            include: ['legacy/**/*.eval.ts'],
            affected: { global: ['legacy.lock'] },
        },
    }],
};
`);
        writeFile(root, 'pathgrade.config.ts', `
export default {
    runner: { adapter: 'vitest', args: ['--reporter=dot'] },
    evals: { include: ['canonical/**/*.eval.ts'] },
    affected: { global: ['canonical.lock'] },
};
`);

        const config = await resolvePathgradeConfig({
            cwd: root,
            cli: {
                runner: { args: ['--grep', 'smoke'] },
                affected: { global: ['cli.lock'] },
            },
        });

        expect(config.runner).toEqual({
            adapter: 'vitest',
            args: ['--grep', 'smoke'],
        });
        expect(config.evals.include).toEqual(['canonical/**/*.eval.ts']);
        expect(config.affected.global).toEqual(['cli.lock']);
    });

    it('fails clearly when an explicit config path cannot be loaded', async () => {
        const root = makeRepo();

        await expect(resolvePathgradeConfig({
            cwd: root,
            configPath: 'missing.pathgrade.config.ts',
        })).rejects.toThrow(/failed to load missing\.pathgrade\.config\.ts/);
    });

    it('fails clearly when pathgrade.config.ts exports a non-object value', async () => {
        const root = makeRepo();
        writeFile(root, 'pathgrade.config.ts', `
export default 'not config';
`);

        await expect(resolvePathgradeConfig({ cwd: root }))
            .rejects.toThrow(/invalid pathgrade\.config\.ts: default export must be an object/);
    });

    it('fails clearly when pathgrade.config.ts contains malformed fields', async () => {
        const root = makeRepo();
        writeFile(root, 'pathgrade.config.ts', `
export default {
    evals: { include: '**/*.eval.ts' },
};
`);

        await expect(resolvePathgradeConfig({ cwd: root }))
            .rejects.toThrow(/invalid pathgrade\.config\.ts: evals\.include must be an array of strings/);
    });
});
