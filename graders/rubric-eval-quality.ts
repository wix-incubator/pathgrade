import { llmRubricGrader } from '../src/core/grader-factories';

export const rubricEvalQuality = llmRubricGrader({
    rubric: `Evaluate the generated eval.ts quality:

Structure (0-0.4):
- Does eval.ts use defineEval() correctly?
- Are defaults sensibly configured?
- Does it define at least one well-structured task?

Task Quality (0-0.3):
- Is the instruction specific enough for an agent to follow?
- Are workspace files mapped correctly?
- Are grader weights reasonable?

Grader Design (0-0.3):
- Does it include both deterministicGrader() and llmRubricGrader()?
- Is the deterministic grader checking concrete outcomes via execute()?
- Is the LLM rubric focused on qualitative assessment?`,
    weight: 0.3,
});
