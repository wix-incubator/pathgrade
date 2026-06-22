import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const forbiddenCoreImport = /from\s+['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/browser|\/cli|\/report-summary|\/github-comment)?(?:\.js)?|(?:\.\.\/)+utils\/cli(?:\.js)?|child_process)['"]|import\s*['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/browser|\/cli|\/report-summary|\/github-comment)?(?:\.js)?|(?:\.\.\/)+utils\/cli(?:\.js)?|child_process)['"]/;

describe('reporting dependency boundary', () => {
    it('keeps the reporting core free of runner, plugin, CLI, and presentation imports', () => {
        for (const file of ['core.ts', 'artifacts.ts', 'types.ts']) {
            const source = fs.readFileSync(path.join(process.cwd(), 'src/reporting', file), 'utf8');
            expect(source, `${file} must stay runner-neutral`).not.toMatch(forbiddenCoreImport);
        }
    });

    it('keeps the Vitest reporter as translation and presentation glue', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugin/reporter.ts'), 'utf8');

        expect(source).toContain("from '../reporting/vitest-edge.js'");
        expect(source).toContain("from '../reporting/core.js'");
        expect(source).toContain("from '../reporting/artifacts.js'");
        expect(source).toContain('collectVitestReportGroups(testModules)');
        expect(source).toContain('buildPathgradeReport({');
        expect(source).toContain('writePathgradeArtifacts(outputDir, built)');
        expect(source).not.toContain('private collectGroups');
        expect(source).not.toContain('private buildEvalReport');
        expect(source).not.toContain('private toTrialResult');
    });
});
