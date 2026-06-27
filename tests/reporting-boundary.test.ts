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

    it('routes the Vitest reporter through the adapter and Pathgrade-owned orchestrator', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/adapters/vitest/reporter.ts'), 'utf8');

        expect(source).toContain("from '../../runners/vitest-adapter.js'");
        expect(source).toContain("from '../../runners/orchestrator.js'");
        expect(source).toContain('createVitestAdapter({ testModules })');
        expect(source).toContain('runWithAdapter({');
        expect(source).not.toContain("from '../reporting/vitest-edge.js'");
        expect(source).not.toContain("from '../reporting/core.js'");
        expect(source).not.toContain("from '../reporting/artifacts.js'");
        expect(source).not.toContain('collectVitestReportGroups(testModules)');
        expect(source).not.toContain('buildPathgradeReport({');
        expect(source).not.toContain('writePathgradeArtifacts(outputDir, built)');
        expect(source).not.toContain('private collectGroups');
        expect(source).not.toContain('private buildEvalReport');
        expect(source).not.toContain('private toTrialResult');
    });
});
