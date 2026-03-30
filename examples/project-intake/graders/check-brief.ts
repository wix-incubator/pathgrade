import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkBrief = deterministicGrader({
    weight: 0.5,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];
        const artifactsDir = path.join(workspacePath, 'artifacts');

        let briefPath: string | null = null;
        if (fs.existsSync(artifactsDir)) {
            const files = fs.readdirSync(artifactsDir)
                .filter(f => /^project-brief-.*\.md$/.test(f));
            if (files.length > 0) {
                briefPath = path.join(artifactsDir, files[0]);
            }
        }

        checks.push({
            name: 'brief-exists',
            passed: briefPath !== null,
            message: briefPath ? `Found ${briefPath}` : 'No project-brief-*.md found in artifacts/',
        });

        if (!briefPath) {
            return { score: 0, details: '0/5 checks passed — brief file not found', checks };
        }

        const content = fs.readFileSync(briefPath, 'utf-8');

        const hasContext = /^##\s+Context/m.test(content);
        checks.push({ name: 'has-context', passed: hasContext, message: hasContext ? 'Has Context section' : 'Missing Context section' });

        const hasDirection = /^##\s+Direction/m.test(content);
        checks.push({ name: 'has-direction', passed: hasDirection, message: hasDirection ? 'Has Direction section' : 'Missing Direction section' });

        const hasGoal = /^##\s+Goal/m.test(content);
        checks.push({ name: 'has-goal', passed: hasGoal, message: hasGoal ? 'Has Goal section' : 'Missing Goal section' });

        const hasTargetGroup = /^##\s+Target\s+Group/m.test(content);
        checks.push({ name: 'has-target-group', passed: hasTargetGroup, message: hasTargetGroup ? 'Has Target Group section' : 'Missing Target Group section' });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
