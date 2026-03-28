import { llmRubricGrader } from '../src/core/grader-factories';

export const rubricGraderQuality = llmRubricGrader({
    rubric: `Evaluate the grader file quality:

Correctness (0-0.4):
- Does the file use deterministicGrader() factory?
- Does it export the grader?
- Does execute() return { score, details, checks }?

Robustness (0-0.3):
- Does it handle the case where output.txt doesn't exist?
- Does it use proper async/await patterns?

Code Quality (0-0.3):
- Is the code well-structured and readable?
- Are check results descriptive?`,
    weight: 0.3,
});
