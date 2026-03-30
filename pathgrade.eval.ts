import { defineEval } from './src/core/define-eval';
import { checkEvalTs } from './graders/check-eval-ts';
import { checkGraderAuthoring } from './graders/check-grader-authoring';
import { rubricEvalQuality } from './graders/rubric-eval-quality';
import { rubricGraderQuality } from './graders/rubric-grader-quality';

export default defineEval({
  defaults: {
    agent: 'claude',
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
1. The eval.ts must import defineEval from 'pathgrade'
2. It must define at least one task under tasks
3. Each task must have: name, instruction, workspace, and graders
4. Include at least one deterministicGrader() and one llmRubricGrader()
5. The deterministicGrader must have an execute function that returns { score, details }
6. The instruction for each task should be specific and actionable
7. Save the file as eval.ts in the current directory`,

      workspace: [
        { dir: 'fixtures/create-eval-config' },
      ],

      graders: [
        checkEvalTs,
        rubricEvalQuality,
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
2. Import deterministicGrader from 'pathgrade'
3. Export a grader using deterministicGrader({ execute: ... })
4. The execute function should return { score, details, checks }
5. Check 1: verify output.txt exists
6. Check 2: verify output.txt contains "Hello, World!"
7. Score should be the proportion of checks that passed`,

      workspace: [
        { dir: 'fixtures/write-deterministic-grader' },
      ],

      graders: [
        checkGraderAuthoring,
        rubricGraderQuality,
      ],
    },
  ],
});
