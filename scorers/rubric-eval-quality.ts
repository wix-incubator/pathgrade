import { judge } from '../src/sdk';

export const rubricEvalQuality = judge('eval-quality', {
    rubric: `Evaluate the generated .eval.ts quality:

Structure (0-0.4):
- Does the file use the current pathgrade API?
- Does it create a trial and call grade()?
- Is the overall test structure coherent and runnable?

Task Quality (0-0.3):
- Is the instruction specific enough for an agent to follow?
- Are workspace files mapped correctly if present?
- Are scorer weights reasonable?

Scorer Design (0-0.3):
- Does it include deterministic scoring via check() or score()?
- Does it include qualitative scoring via judge()?
- Are the observable checks aligned with the instruction?`,
    weight: 0.3,
});
