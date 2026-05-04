import { score } from '../src/sdk';
import * as fs from 'fs';
import * as path from 'path';

export const checkScorerAuthoring = score(
    'scorer-authoring',
    async ({ workspace }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const scorersDir = path.join(workspace, 'scorers');
        let scorerFile: string | null = null;
        if (fs.existsSync(scorersDir)) {
            const files = fs.readdirSync(scorersDir).filter((f) => f.endsWith('.ts'));
            if (files.length > 0) scorerFile = files[0];
        }
        checks.push({
            name: 'scorer-file-exists',
            passed: scorerFile !== null,
            message: scorerFile ? `Found scorers/${scorerFile}` : 'No .ts file in scorers/',
        });

        if (!scorerFile) {
            return { score: 0, details: '0/4 checks passed', checks };
        }

        const content = fs.readFileSync(path.join(scorersDir, scorerFile), 'utf8');

        const usesFactory = /check\s*\(|score\s*\(|judge\s*\(|toolUsage\s*\(/.test(content);
        checks.push({
            name: 'uses-factory',
            passed: usesFactory,
            message: usesFactory ? 'Uses current scorer helper' : 'Missing scorer helper call',
        });

        const hasExport = /export\s/.test(content);
        checks.push({
            name: 'has-export',
            passed: hasExport,
            message: hasExport ? 'Exports scorer' : 'Missing export',
        });

        const hasObservableLogic = /workspace|transcript|toolEvents|runCommand/.test(content);
        checks.push({
            name: 'uses-observable-surface',
            passed: hasObservableLogic,
            message: hasObservableLogic ? 'Uses observable scorer inputs' : 'No observable scorer logic found',
        });

        const passed = checks.filter((c) => c.passed).length;
        const scoreValue = parseFloat((passed / checks.length).toFixed(2));
        return { score: scoreValue, details: `${passed}/${checks.length} checks passed`, checks };
    },
    { weight: 0.7 },
);
