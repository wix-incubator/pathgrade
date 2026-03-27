import { defineEval } from './src/core/define-eval';
import { llmRubricGrader } from './src/core/grader-factories';
import { checkEvalTs } from './graders/check-eval-ts';
import { checkGraderAuthoring } from './graders/check-grader-authoring';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 600,
    threshold: 0.7,
    environment: {
      cpus: 2,
      memory_mb: 2048,
    },
  },

  tasks: [
    {
      name: 'create-eval-config',
      type: 'instruction',
      instruction: `A skill called "code-formatter" is defined in SKILL.md.
Create a valid eval.ts that evaluates this skill using defineEval().

Requirements:
1. The eval.ts must import defineEval from '@wix/pathgrade'
2. It must define at least one task under tasks
3. Each task must have: name, instruction, workspace, and graders
4. Include at least one deterministicGrader() and one llmRubricGrader()
5. The deterministicGrader must have an execute function that returns { score, details }
6. The instruction for each task should be specific and actionable
7. Save the file as eval.ts in the current directory`,

      workspace: [
        { src: 'fixtures/code-formatter-skill.md', dest: 'SKILL.md' },
      ],

      graders: [
        checkEvalTs,
        llmRubricGrader({
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
        }),
      ],
    },

    {
      name: 'write-deterministic-grader',
      type: 'instruction',
      instruction: `Write a deterministic grader for a pathgrade evaluation.

The grader should verify that a file called output.txt was created
and contains the text "Hello, World!".

Requirements:
1. Create a TypeScript file at graders/check-output.ts
2. Import deterministicGrader from '@wix/pathgrade'
3. Export a grader using deterministicGrader({ execute: ... })
4. The execute function should return { score, details, checks }
5. Check 1: verify output.txt exists
6. Check 2: verify output.txt contains "Hello, World!"
7. Score should be the proportion of checks that passed`,

      workspace: [
        { src: 'fixtures/sample-output.txt', dest: 'expected-output.txt' },
      ],

      graders: [
        checkGraderAuthoring,
        llmRubricGrader({
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
        }),
      ],
    },
  ],
});
