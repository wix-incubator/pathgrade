import { judge } from '../src/sdk';

export const rubricScorerQuality = judge('scorer-file-quality', {
    rubric: `Evaluate the scorer file quality:

Correctness (0-0.4):
- Does the file use current scorer helpers such as check(), score(), judge(), or toolUsage()?
- Does it export the scorer?
- Does the scoring logic return clear score/details semantics?

Robustness (0-0.3):
- Does it handle missing files or invalid workspace state safely?
- Does it use proper async/await patterns where needed?

Code Quality (0-0.3):
- Is the code well-structured and readable?
- Are result messages descriptive and actionable?`,
    weight: 0.3,
});
