import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathgrade } from '../src/plugin/index.js';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-plugin-'));
}

function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('pathgrade plugin exclude', () => {
    it('default exclude includes worktree patterns and vitest defaults', () => {
        const plugin = pathgrade();
        const config = plugin.config();

        expect(config.test.exclude).toContain('.worktrees/**');
        expect(config.test.exclude).toContain('worktrees/**');
        // Vitest defaults are preserved
        expect(config.test.exclude).toContain('**/node_modules/**');
        expect(config.test.exclude).toContain('**/.git/**');
    });

    it('user-provided exclude replaces defaults', () => {
        const plugin = pathgrade({ exclude: ['custom/**'] });
        const config = plugin.config();

        expect(config.test.exclude).toEqual(['custom/**']);
    });

    it('filters foreign .eval.ts files out of the resolved include list', () => {
        const root = makeTempRepo();
        writeFile(
            root,
            'evals/real.eval.ts',
            `import { createAgent } from '@wix/pathgrade';
void createAgent;
`,
        );
        writeFile(
            root,
            'evals/meta.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { deps: ['src/**'] };
`,
        );
        writeFile(
            root,
            'evals/foreign.eval.ts',
            `import { defineTriggerSuite } from './define-trigger-suite.js';
export default defineTriggerSuite();
`,
        );

        const plugin = pathgrade({ include: ['evals/**/*.eval.ts'] });
        const config = plugin.config();
        const resolved = {
            root,
            test: {
                include: [...config.test.include],
                exclude: [...config.test.exclude],
            },
        };

        plugin.configResolved?.(resolved);

        expect(resolved.test.include).toEqual([
            'evals/meta.eval.ts',
            'evals/real.eval.ts',
        ]);
    });
});
