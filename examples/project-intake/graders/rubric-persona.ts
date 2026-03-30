import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricPersona = llmRubricGrader({
    rubric: `Evaluate the full persona-driven conversation.

Skill Discovery (0-0.2):
- Did the agent discover and use project-intake?

Conversation Flow (0-0.4):
- One question per turn?
- Adapted to user's communication style?
- Handled open-ended responses well?

Brief Quality (0-0.4):
- Complete brief with all sections?
- Content matches the facts the persona provided?
- Project name reasonable?`,
    weight: 0.5,
});
