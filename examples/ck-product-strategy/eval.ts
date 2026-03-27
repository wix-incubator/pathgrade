import { defineEval } from '@wix/pathgrade';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
  },

  tasks: [
    {
      name: 'test-ck-product-strategy',
      instruction: `TODO: Write an instruction based on this skill.
      Skill description: Helps Creators shape product strategy so they can **validate direction**, **align stakeholders**, and make **confident high-level decisions** before investing in detailed specifications and development.`,

      // workspace: [
      //   { src: 'fixtures/broken-file.js', dest: 'app.js' },
      //   { src: 'bin/my-tool', dest: '/usr/local/bin/my-tool', chmod: '+x' },
      // ],

      graders: [
        {
          type: 'deterministic',
          // Grader must output JSON: { "score": 0.0-1.0, "details": "...", "checks": [...] }
          run: `echo '{"score": 0.0, "details": "TODO: implement grader"}'`,
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: `TODO: Write evaluation criteria.`,
          weight: 0.3,
        },
      ],

      // Optional: reference solution for --validate
      // solution: 'solutions/solve.sh',
    },
  ],
});
