import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverEvalFiles } from '../src/commands/affected.js';

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-discover-'));
}

function writeFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('discoverEvalFiles', () => {
    it('keeps only PathGrade evals discovered by import or __pathgradeMeta', () => {
        const root = makeTempRepo();
        writeFile(
            root,
            'skills/real/test/real.eval.ts',
            `import { createAgent } from '@wix/pathgrade';
describe('real', () => {
    void createAgent;
});
`,
        );
        writeFile(
            root,
            'evals/meta-only.eval.ts',
            `import type { PathgradeMeta } from '@wix/pathgrade';
export const __pathgradeMeta: PathgradeMeta = { deps: ['src/**'] };
`,
        );
        writeFile(
            root,
            'skills/foreign/evals/triggers.eval.ts',
            `import { defineTriggerSuite } from './define-trigger-suite.js';
export default defineTriggerSuite();
`,
        );

        expect(discoverEvalFiles(root)).toEqual([
            'evals/meta-only.eval.ts',
            'skills/real/test/real.eval.ts',
        ]);
    });

    it('ignores commented-out PathGrade imports and meta markers', () => {
        const root = makeTempRepo();
        writeFile(
            root,
            'skills/foreign/evals/commented.eval.ts',
            `// import { createAgent } from '@wix/pathgrade';
/* export const __pathgradeMeta = { deps: ['src/**'] }; */
export const framework = 'trigger-evals';
`,
        );

        expect(discoverEvalFiles(root)).toEqual([]);
    });

    it('detects PathGrade signals beyond the first 4 KB of the file', () => {
        const root = makeTempRepo();
        writeFile(
            root,
            'skills/real/test/late-import.eval.ts',
            `${'// banner padding\n'.repeat(400)}import { createAgent } from '@wix/pathgrade';
void createAgent;
`,
        );

        expect(discoverEvalFiles(root)).toEqual([
            'skills/real/test/late-import.eval.ts',
        ]);
    });
});
