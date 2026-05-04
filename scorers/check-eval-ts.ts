import { score } from '../src/sdk';
import * as fs from 'fs';

export const checkEvalTs = score(
    'eval-file-shape',
    async ({ workspace }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        const files = fs.readdirSync(workspace);
        const evalFile = files.find((f) => f.endsWith('.eval.ts')) || (fs.existsSync(`${workspace}/eval.ts`) ? 'eval.ts' : null);
        const exists = evalFile !== null;
        checks.push({ name: 'file-exists', passed: exists, message: exists ? `${evalFile} exists` : 'No *.eval.ts found' });

        if (!exists) {
            return { score: 0, details: '0/5 checks passed — no *.eval.ts found', checks };
        }

        const content = fs.readFileSync(`${workspace}/${evalFile}`, 'utf8');

        const hasCreateAgent = /createAgent/.test(content);
        checks.push({ name: 'has-create-agent', passed: hasCreateAgent, message: hasCreateAgent ? 'Uses createAgent()' : 'Missing createAgent()' });

        const hasEvaluate = /evaluate\s*\(/.test(content);
        checks.push({ name: 'has-evaluate', passed: hasEvaluate, message: hasEvaluate ? 'Uses evaluate()' : 'Missing evaluate() call' });

        const hasDeterministicScorer = /check\s*\(|score\s*\(/.test(content);
        checks.push({ name: 'has-deterministic-scorer', passed: hasDeterministicScorer, message: hasDeterministicScorer ? 'Has check() or score()' : 'Missing deterministic scorer' });

        const hasJudgeScorer = /judge\s*\(/.test(content);
        checks.push({ name: 'has-judge-scorer', passed: hasJudgeScorer, message: hasJudgeScorer ? 'Has judge()' : 'Missing judge() scorer' });

        const passed = checks.filter((c) => c.passed).length;
        const scoreValue = parseFloat((passed / checks.length).toFixed(2));
        return { score: scoreValue, details: `${passed}/${checks.length} checks passed`, checks };
    },
    { weight: 0.7 },
);
