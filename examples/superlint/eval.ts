// Superlint Example (Simple)
//
// This example demonstrates a basic pathgrade setup with:
// - A simple bash deterministic grader
// - An LLM rubric for qualitative assessment
// - Workspace file mapping (fixtures + tool binary)
//
// Run:
//   cd examples/superlint
//   GEMINI_API_KEY=your-key pathgrade --smoke

import { defineEval } from '../../src/core/define-eval';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    environment: {
      cpus: 2,
      memory_mb: 2048,
    },
  },
  tasks: [
    {
      name: 'fix-linting-errors',
      type: 'instruction',
      instruction: `Our internal app.js violates our coding standards (double quotes, var usage).
Use our proprietary superlint tool to fix these issues.

## Mandatory Workflow

1. Check — Run \`superlint check\` to identify issues
2. Fix — Run \`superlint fix --target app.js\` to apply corrections
3. Verify — Run \`superlint verify\` to finalize and generate \`.superlint-passed\`
`,
      workspace: [
        { src: 'fixtures/app.js', dest: 'app.js' },
        { src: 'bin/superlint', dest: '/usr/local/bin/superlint' },
      ],
      graders: [
        {
          type: 'deterministic',
          run: String.raw`passed=0
total=2
c1_pass=false c1_msg="Verification file missing"
c2_pass=false c2_msg="Code not properly fixed"

if test -f .superlint-passed; then
  passed=$((passed + 1))
  c1_pass=true; c1_msg="Verification file exists"
fi

if grep -q "const greeting = 'hello world';" app.js 2>/dev/null; then
  passed=$((passed + 1))
  c2_pass=true; c2_msg="Code uses const and single quotes"
fi

score=$(awk "BEGIN {printf \"%.2f\", $passed/$total}")
echo "{\"score\":$score,\"details\":\"$passed/$total checks passed\",\"checks\":[{\"name\":\"superlint-passed\",\"passed\":$c1_pass,\"message\":\"$c1_msg\"},{\"name\":\"code-fixed\",\"passed\":$c2_pass,\"message\":\"$c2_msg\"}]}"`,
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: `Evaluate the agent's approach:

Workflow Compliance (0-0.5):
- Did the agent follow check → fix → verify?
- Did it use superlint (not eslint or manual edits)?

Efficiency (0-0.5):
- Completed in ≤5 commands?
- No unnecessary trial-and-error?`,
          weight: 0.3,
        },
      ],
    },
  ],
});
