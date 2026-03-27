import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkStrategy = deterministicGrader({
    weight: 0.5,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];
        const productDir = path.join(workspacePath, 'artifacts', 'product');

        let strategyPath: string | null = null;
        if (fs.existsSync(productDir)) {
            const files = fs.readdirSync(productDir)
                .filter(f => /^product-strategy-.*\.md$/.test(f));
            if (files.length > 0) {
                strategyPath = path.join(productDir, files[0]);
            }
        }

        checks.push({
            name: 'strategy-file-exists',
            passed: strategyPath !== null,
            message: strategyPath ? `Found ${strategyPath}` : 'No product-strategy-*.md found in artifacts/product/',
        });

        if (!strategyPath) {
            return { score: 0, details: '0/8 checks passed — strategy file not found', checks };
        }

        const content = fs.readFileSync(strategyPath, 'utf-8');

        const hasTargetAudience = /target\s+audience/i.test(content) && /primary\s+user/i.test(content);
        checks.push({ name: 'has-target-audience', passed: hasTargetAudience, message: hasTargetAudience ? 'Has Target Audience with Primary User' : 'Missing Target Audience section or Primary User' });

        const hasProblemStatement = /problem\s+statement/i.test(content) && (/5\s*whys?/i.test(content) || /why\?/i.test(content));
        checks.push({ name: 'has-problem-statement', passed: hasProblemStatement, message: hasProblemStatement ? 'Has Problem Statement with 5 Whys' : 'Missing Problem Statement or 5 Whys chain' });

        const hasIntents = /intents?\s*(and|&)\s*feelings?/i.test(content) && /#int-\d{3}/.test(content);
        checks.push({ name: 'has-intents-feelings', passed: hasIntents, message: hasIntents ? 'Has Intents & Feelings with intent IDs' : 'Missing Intents & Feelings section or intent IDs (#int-001)' });

        const hasSolution = /solution\s+(statement|direction)/i.test(content);
        checks.push({ name: 'has-solution-statement', passed: hasSolution, message: hasSolution ? 'Has Solution Statement/Direction' : 'Missing Solution Statement or Direction' });

        const hasSolutionSummary = /product\s+solution\s+summary/i.test(content) || /what\s+we.{0,3}re\s+building/i.test(content);
        checks.push({ name: 'has-solution-summary', passed: hasSolutionSummary, message: hasSolutionSummary ? 'Has Product Solution Summary' : 'Missing Product Solution Summary' });

        const hasWhyNow = /why\s+now/i.test(content) && /business\s+impact/i.test(content);
        checks.push({ name: 'has-why-now', passed: hasWhyNow, message: hasWhyNow ? 'Has Why Now & Business Impact' : 'Missing Why Now or Business Impact section' });

        const hasKPIs = /kpis?/i.test(content) && /[↑↓]/u.test(content);
        checks.push({ name: 'has-kpis', passed: hasKPIs, message: hasKPIs ? 'Has KPIs with directional indicators' : 'Missing KPIs or directional indicators (↑/↓)' });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
