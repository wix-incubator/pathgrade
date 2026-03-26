/**
 * Deterministic grader for the create-eval-config task.
 * Validates that the agent produced a valid eval.ts.
 */
const fs = require('fs');

function run() {
    const checks = [];
    let passed = 0;
    const total = 5;

    // Check 1: eval.ts exists
    const exists = fs.existsSync('eval.ts');
    if (exists) passed++;
    checks.push({ name: 'file-exists', passed: exists, message: exists ? 'eval.ts exists' : 'eval.ts not found' });

    if (!exists) {
        console.log(JSON.stringify({ score: 0, details: '0/5 checks passed — eval.ts not found', checks }));
        return;
    }

    const content = fs.readFileSync('eval.ts', 'utf8');

    // Check 2: imports defineEval
    const hasDefineEval = /defineEval/.test(content);
    if (hasDefineEval) passed++;
    checks.push({ name: 'has-define-eval', passed: hasDefineEval, message: hasDefineEval ? 'uses defineEval()' : 'Missing defineEval import' });

    // Check 3: has tasks array
    const hasTasks = /tasks\s*:/.test(content);
    if (hasTasks) passed++;
    checks.push({ name: 'has-tasks', passed: hasTasks, message: hasTasks ? 'tasks defined' : 'Missing tasks' });

    // Check 4: has deterministic grader
    const hasDeterministic = /['"]deterministic['"]/.test(content);
    if (hasDeterministic) passed++;
    checks.push({ name: 'has-deterministic', passed: hasDeterministic, message: hasDeterministic ? 'Has deterministic grader' : 'Missing deterministic grader' });

    // Check 5: has llm_rubric grader
    const hasLlmRubric = /['"]llm_rubric['"]/.test(content);
    if (hasLlmRubric) passed++;
    checks.push({ name: 'has-llm-rubric', passed: hasLlmRubric, message: hasLlmRubric ? 'Has llm_rubric grader' : 'Missing llm_rubric grader' });

    const score = passed / total;
    console.log(JSON.stringify({ score, details: `${passed}/${total} checks passed`, checks }));
}

run();
