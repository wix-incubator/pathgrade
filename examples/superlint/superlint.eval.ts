import { defineEval } from '../../src/core/define-eval';
import { checkLint } from './graders/check-lint';
import { rubricWorkflow } from './graders/rubric-workflow';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    environment: {
      cpus: 2,
      memory_mb: 2048,
    },
  },
  tasks: [
    {
      name: 'fix-linting-errors',
      type: 'instruction',
      instruction: `Our internal app.js violates our coding standards (double quotes, var usage).
Use our proprietary superlint tool to fix these issues.

## Mandatory Workflow

1. Check — Run \`superlint check\` to identify issues
2. Fix — Run \`superlint fix --target app.js\` to apply corrections
3. Verify — Run \`superlint verify\` to finalize and generate \`.superlint-passed\`
`,
      workspace: [
        { src: 'fixtures/app.js', dest: 'app.js' },
        { src: 'bin/superlint', dest: '/usr/local/bin/superlint', chmod: '+x' },
      ],
      graders: [
        checkLint,
        rubricWorkflow,
      ],
    },
  ],
});
