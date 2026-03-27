import { deterministicGrader } from '../src/core/grader-factories';
import * as fs from 'fs';

export const checkEvalTs = deterministicGrader({
    weight: 0.7,
    execute: async ({ workspacePath }) => {
        const checks: Array<{ name: string; passed: boolean; message: string }> = [];

        // Find *.eval.ts file
        const files = fs.readdirSync(workspacePath);
        const evalFile = files.find(f => f.endsWith('.eval.ts')) || (fs.existsSync(`${workspacePath}/eval.ts`) ? 'eval.ts' : null);
        const exists = evalFile !== null;
        checks.push({ name: 'file-exists', passed: exists, message: exists ? `${evalFile} exists` : 'No *.eval.ts found' });

        if (!exists) {
            return { score: 0, details: '0/5 checks passed — no *.eval.ts found', checks };
        }

        const content = fs.readFileSync(`${workspacePath}/${evalFile}`, 'utf8');

        // Check: imports defineEval
        const hasDefineEval = /defineEval/.test(content);
        checks.push({ name: 'has-define-eval', passed: hasDefineEval, message: hasDefineEval ? 'uses defineEval()' : 'Missing defineEval import' });

        // Check: has tasks array
        const hasTasks = /tasks\s*:/.test(content);
        checks.push({ name: 'has-tasks', passed: hasTasks, message: hasTasks ? 'tasks defined' : 'Missing tasks' });

        // Check: has deterministic grader (new API pattern)
        const hasDeterministic = /deterministicGrader\s*\(/.test(content);
        checks.push({ name: 'has-deterministic', passed: hasDeterministic, message: hasDeterministic ? 'Has deterministicGrader()' : 'Missing deterministicGrader()' });

        // Check: has llm_rubric grader (new API pattern)
        const hasLlmRubric = /llmRubricGrader\s*\(/.test(content);
        checks.push({ name: 'has-llm-rubric', passed: hasLlmRubric, message: hasLlmRubric ? 'Has llmRubricGrader()' : 'Missing llmRubricGrader()' });

        const passed = checks.filter(c => c.passed).length;
        const score = parseFloat((passed / checks.length).toFixed(2));
        return { score, details: `${passed}/${checks.length} checks passed`, checks };
    },
});
