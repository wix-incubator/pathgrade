import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricScripted = llmRubricGrader({
    rubric: `Evaluate the multi-turn conversation for ck-new skill compliance.

Workflow (0-0.4):
- Did the agent ask questions one at a time (not multiple in one message)?
- Did the agent follow a flexible intake flow that still covered the required topics?
- Did it gather or reasonably infer the required topics (Context, Direction, Goal, Target Group)?
- Did it offer structured choices for Goal and Target Group when appropriate?

Brief Quality (0-0.4):
- Is the brief at artifacts/project-brief-*.md?
- Does it have all required sections (Context, Direction, Goal, Target Group)?
- Is content refined (not just echoing user replies)?
- Once enough information was available, did the agent move to writing the brief instead of stalling?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary back-and-forth)?
- Did the agent react naturally to user responses?`,
    weight: 0.5,
});
