import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkFix = deterministicGrader({
    weight: 0.6,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const appPath = path.join(workspacePath, 'app.js');
        const exists = fs.existsSync(appPath);
        checks.push({
            name: 'file-exists',
            passed: exists,
            message: exists ? 'app.js exists' : 'app.js not found',
        });

        if (!exists) {
            return { score: 0, details: '0/2 — file not found', checks };
        }

        try {
            try { delete require.cache[require.resolve(appPath)]; } catch {}
            const mod = require(appPath);
            const fn = mod.add || mod.default;
            const result = fn?.(2, 3);
            const correct = result === 5;
            checks.push({
                name: 'fix-correct',
                passed: correct,
                message: correct ? 'Function returns correct result' : `Got ${result}, expected 5`,
            });
        } catch (e: unknown) {
            checks.push({
                name: 'fix-correct',
                passed: false,
                message: `Error: ${(e as Error).message}`,
            });
        }

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
