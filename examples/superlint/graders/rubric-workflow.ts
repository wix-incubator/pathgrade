import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricWorkflow = llmRubricGrader({
    rubric: `Evaluate the agent's approach:

Workflow Compliance (0-0.5):
- Did the agent follow check → fix → verify?
- Did it use superlint (not eslint or manual edits)?

Efficiency (0-0.5):
- Completed in ≤5 commands?
- No unnecessary trial-and-error?`,
    weight: 0.3,
});
