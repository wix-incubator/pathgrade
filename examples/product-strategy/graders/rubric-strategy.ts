import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricStrategy = llmRubricGrader({
    rubric: `Evaluate the agent's execution of the product-strategy skill across a multi-turn conversation.

Workflow Compliance (0-0.4):
- Did the agent follow the section-by-section workflow in order (Target Audience → Problem Statement → Intents & Feelings → Solution Statement → Product Solution Summary → Why Now & KPIs)?
- Did the agent work on ONE section at a time, waiting for user approval before moving to the next?
- Did the agent use structured choices (ask-user tool or multiple choice options) for decision points?
- Did the agent scan for and acknowledge input artifacts (project brief, research) in Step 0?
- Did the agent handle the annual plan check in Step 5 (found it or asked how to proceed)?

Content Quality (0-0.4):
- Does the Target Audience section include Primary User with User Impact and Business Impact?
- Does the Problem Statement use the 5 Whys method and show the reasoning chain?
- Do Intents & Feelings use first-person format ("I want to...") with numbered intent IDs (#int-001)?
- Is the Solution Statement a concise direction (not features or UI details)?
- Does the Product Solution Summary include concrete capabilities, feasibility, and V1 vs later scope?
- Does Why Now reference specific evidence or strategic alignment (e.g., annual plan, competitive gap)?
- Are KPIs measurable with directional indicators (↑/↓), and never using NPS?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary repetition or excessive back-and-forth)?
- Did the agent adapt naturally to user responses?
- Did the agent present drafted sections before asking for approval (not just asking questions endlessly)?
- Was the final document saved to the correct path (artifacts/product/product-strategy-*.md)?`,
    weight: 0.5,
});
