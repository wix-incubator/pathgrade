import { deterministicGrader } from '../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkGraderAuthoring = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        // Check 1: grader .ts file exists in graders/
        const gradersDir = path.join(workspacePath, 'graders');
        let graderFile: string | null = null;
        if (fs.existsSync(gradersDir)) {
            const files = fs.readdirSync(gradersDir).filter(f => f.endsWith('.ts'));
            if (files.length > 0) graderFile = files[0];
        }
        checks.push({
            name: 'grader-file-exists',
            passed: graderFile !== null,
            message: graderFile ? `Found graders/${graderFile}` : 'No .ts file in graders/',
        });

        if (!graderFile) {
            return { score: 0, details: '0/4 checks passed', checks };
        }

        const content = fs.readFileSync(path.join(gradersDir, graderFile), 'utf8');

        // Check 2: uses deterministicGrader factory
        const usesFactory = /deterministicGrader\s*\(/.test(content);
        checks.push({
            name: 'uses-factory',
            passed: usesFactory,
            message: usesFactory ? 'Uses deterministicGrader()' : 'Missing deterministicGrader() call',
        });

        // Check 3: has execute function
        const hasExecute = /execute\s*:/.test(content);
        checks.push({
            name: 'has-execute',
            passed: hasExecute,
            message: hasExecute ? 'Has execute function' : 'Missing execute function',
        });

        // Check 4: exports a grader
        const hasExport = /export\s/.test(content);
        checks.push({
            name: 'has-export',
            passed: hasExport,
            message: hasExport ? 'Exports grader' : 'Missing export',
        });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
