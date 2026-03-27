import { defineEval } from '../../src/core/define-eval';
import { toolUsageGrader } from '../../src/core/grader-factories';
import { checkFix } from './graders/check';

export default defineEval({
  tasks: [{
    name: 'tool-aware-fix',
    type: 'instruction',
    instruction: 'Inspect app.js, fix the failing test, and verify it.',
    workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
    graders: [
      toolUsageGrader({
        weight: 0.4,
        expectations: [
          { action: 'read_file', min: 1, weight: 0.3 },
          { action: 'edit_file', min: 1, weight: 0.3 },
          { action: 'run_shell', command_contains: 'test', min: 1, weight: 0.4 },
        ],
      }),
      checkFix,
    ],
  }],
});
