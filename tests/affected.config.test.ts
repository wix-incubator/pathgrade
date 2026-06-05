import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAffectedConfig } from '../src/affected/config.js';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-config-'));
}

function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('loadAffectedConfig', () => {
    it('returns empty config when vitest.config.ts does not exist', async () => {
        const root = makeTempRepo();
        const config = await loadAffectedConfig(root);
        expect(config).toEqual({ global: [] });
    });

    it('extracts affected.global from a vitest.config.ts that uses the pathgrade plugin', async () => {
        const root = makeTempRepo();
        // Intentionally does not import 'vitest/config' — keeps the test
        // isolated from node_modules resolution. `defineConfig` is identity,
        // so a plain object export is equivalent.
        writeFile(root, 'vitest.config.ts', `
export default {
    plugins: [
        {
            name: 'pathgrade',
            __pathgradeOptions: {
                affected: { global: ['vitest.config.ts', 'yarn.lock'] },
            },
        },
    ],
};
`);
        const warnings: string[] = [];
        const config = await loadAffectedConfig(root, { onWarning: w => warnings.push(w) });
        expect(warnings, `unexpected warnings: ${warnings.join(' | ')}`).toEqual([]);
        expect(config.global).toEqual(['vitest.config.ts', 'yarn.lock']);
        expect(config.include).toBeUndefined();
        expect(config.exclude).toBeUndefined();
    });

    it('extracts include and exclude from a pathgrade plugin config', async () => {
        const root = makeTempRepo();
        writeFile(root, 'custom.vitest.config.ts', `
export default {
    plugins: [
        {
            name: 'pathgrade',
            __pathgradeOptions: {
                include: ['selected/**/*.eval.ts'],
                exclude: ['selected/local-only.eval.ts'],
                affected: { global: ['package.json'] },
            },
        },
    ],
};
`);
        const warnings: string[] = [];
        const config = await loadAffectedConfig(root, {
            configPath: 'custom.vitest.config.ts',
            onWarning: w => warnings.push(w),
        });
        expect(warnings, `unexpected warnings: ${warnings.join(' | ')}`).toEqual([]);
        expect(config).toEqual({
            global: ['package.json'],
            include: ['selected/**/*.eval.ts'],
            exclude: ['selected/local-only.eval.ts'],
        });
    });

    it('warns and returns empty when config has no pathgrade plugin', async () => {
        const root = makeTempRepo();
        writeFile(root, 'vitest.config.ts', `
export default {
    test: { include: ['**/*.test.ts'] },
};
`);
        const warnings: string[] = [];
        const config = await loadAffectedConfig(root, { onWarning: w => warnings.push(w) });
        expect(config.global).toEqual([]);
        expect(warnings.some(w => /pathgrade/i.test(w))).toBe(true);
    });

    it('treats vitest.workspace.ts presence as a v1 limitation (no short-circuit)', async () => {
        const root = makeTempRepo();
        writeFile(root, 'vitest.workspace.ts', `export default [];\n`);
        const warnings: string[] = [];
        const config = await loadAffectedConfig(root, { onWarning: w => warnings.push(w) });
        expect(config.global).toEqual([]);
        expect(warnings.some(w => /workspace/i.test(w))).toBe(true);
    });
});
