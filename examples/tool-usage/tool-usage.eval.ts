import { defineEval } from '../../src/core/define-eval';
import { checkFix } from './graders/check';
import { toolUsageFix } from './graders/tool-usage-fix';

export default defineEval({
  tasks: [{
    name: 'tool-aware-fix',
    type: 'instruction',
    instruction: 'Inspect app.js, fix the failing test, and verify it.',
    workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
    graders: [
      toolUsageFix,
      checkFix,
    ],
  }],
});
