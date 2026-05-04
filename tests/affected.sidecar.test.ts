import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    writeSidecar,
    readSidecar,
    clearSidecar,
    getSidecarPath,
    toSelectionReport,
} from '../src/affected/sidecar.js';
import type { SelectionResult } from '../src/affected/types.js';

function tmpRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-sidecar-'));
}

function makeResult(overrides: Partial<SelectionResult> = {}): SelectionResult {
    return {
        baseRef: 'origin/main@abc1234',
        changedFiles: ['a.ts', 'b.ts'],
        selected: [
            { file: 'skills/alpha/a.eval.ts', reason: 'deps-match', matchedGlob: 'skills/alpha/**' },
        ],
        skipped: [
            { file: 'skills/beta/b.eval.ts', reason: 'no-matching-deps' },
        ],
        warnings: [],
        ...overrides,
    };
}

describe('sidecar', () => {
    it('writeSidecar + readSidecar round-trip with flattened selected list', async () => {
        const cwd = tmpRepo();
        await writeSidecar(cwd, makeResult());
        const loaded = await readSidecar(cwd);
        expect(loaded).toEqual({
            base_ref: 'origin/main@abc1234',
            changed_files_count: 2,
            selected: ['skills/alpha/a.eval.ts'],
            skipped: [{ file: 'skills/beta/b.eval.ts', reason: 'no-matching-deps' }],
        });
    });

    it('includes global_match when present', async () => {
        const cwd = tmpRepo();
        await writeSidecar(cwd, makeResult({
            globalMatch: 'vitest.config.ts',
            selected: [{ file: 'x.eval.ts', reason: 'global-match' }],
            skipped: [],
        }));
        const loaded = await readSidecar(cwd);
        expect(loaded?.global_match).toBe('vitest.config.ts');
    });

    it('readSidecar returns null when file missing', async () => {
        const cwd = tmpRepo();
        expect(await readSidecar(cwd)).toBeNull();
    });

    it('readSidecar returns null and warns on malformed JSON', async () => {
        const cwd = tmpRepo();
        fs.mkdirSync(path.join(cwd, '.pathgrade'), { recursive: true });
        fs.writeFileSync(getSidecarPath(cwd), '{not valid json');
        const warnings: string[] = [];
        const result = await readSidecar(cwd, w => warnings.push(w));
        expect(result).toBeNull();
        expect(warnings.length).toBe(1);
    });

    it('readSidecar returns null and warns on schema mismatch', async () => {
        const cwd = tmpRepo();
        fs.mkdirSync(path.join(cwd, '.pathgrade'), { recursive: true });
        fs.writeFileSync(getSidecarPath(cwd), JSON.stringify({ random: 'object' }));
        const warnings: string[] = [];
        const result = await readSidecar(cwd, w => warnings.push(w));
        expect(result).toBeNull();
        expect(warnings.length).toBe(1);
    });

    it('clearSidecar removes the file', async () => {
        const cwd = tmpRepo();
        await writeSidecar(cwd, makeResult());
        expect(fs.existsSync(getSidecarPath(cwd))).toBe(true);
        await clearSidecar(cwd);
        expect(fs.existsSync(getSidecarPath(cwd))).toBe(false);
    });

    it('clearSidecar is idempotent (no error when file absent)', async () => {
        const cwd = tmpRepo();
        await expect(clearSidecar(cwd)).resolves.toBeUndefined();
    });

    it('toSelectionReport produces sorted file lists for stable diffs', () => {
        const report = toSelectionReport(makeResult({
            selected: [
                { file: 'z.eval.ts', reason: 'deps-match' },
                { file: 'a.eval.ts', reason: 'deps-match' },
            ],
            skipped: [
                { file: 'z2.eval.ts', reason: 'no-matching-deps' },
                { file: 'a2.eval.ts', reason: 'no-matching-deps' },
            ],
        }));
        expect(report.selected).toEqual(['a.eval.ts', 'z.eval.ts']);
        expect(report.skipped.map(s => s.file)).toEqual(['a2.eval.ts', 'z2.eval.ts']);
    });
});
