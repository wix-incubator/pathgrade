import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkLint = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const passedFile = path.join(workspacePath, '.superlint-passed');
        const hasPassed = fs.existsSync(passedFile);
        checks.push({
            name: 'superlint-passed',
            passed: hasPassed,
            message: hasPassed ? 'Verification file exists' : 'Verification file missing',
        });

        const appPath = path.join(workspacePath, 'app.js');
        let codeFixed = false;
        if (fs.existsSync(appPath)) {
            const content = fs.readFileSync(appPath, 'utf-8');
            codeFixed = content.includes("const greeting = 'hello world';");
        }
        checks.push({
            name: 'code-fixed',
            passed: codeFixed,
            message: codeFixed ? 'Code uses const and single quotes' : 'Code not properly fixed',
        });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
