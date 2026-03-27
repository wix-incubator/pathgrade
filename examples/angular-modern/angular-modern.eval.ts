import { defineEval } from '../../src/core/define-eval';
import { llmRubricGrader } from '../../src/core/grader-factories';
import { checkModernApis } from './graders/check-modern-apis';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 600,
    threshold: 0.6,
    environment: {
      cpus: 2,
      memory_mb: 2048,
    },
  },
  tasks: [
    {
      name: 'modernize-component',
      type: 'instruction',
      instruction: `The file \`src/app/user-profile.component.ts\` uses legacy Angular APIs.
Modernize it according to our coding standards defined in SKILL.md.

Specifically:
1. Replace @Input() with signal-based input()
2. Replace @Output() + EventEmitter with signal-based output()
3. Replace constructor injection with inject()
4. Replace *ngIf/*ngFor with @if/@for built-in control flow
5. Remove CommonModule import (not needed with built-in control flow)
`,
      workspace: [
        {
          src: 'fixtures/src/app/user-profile.component.ts',
          dest: 'src/app/user-profile.component.ts',
        },
      ],
      graders: [
        checkModernApis,
        llmRubricGrader({
          rubric: `Evaluate the agent's migration approach:

Correctness (0-0.4):
- Are signal inputs properly typed with input<Type>() or input.required<Type>()?
- Is inject() used correctly with the right service type?
- Is the template syntax correct (@if/@for)?
- Does the component still function logically?

Completeness (0-0.3):
- Were ALL @Input/@Output decorators migrated?
- Was constructor DI fully replaced?
- Were ALL structural directives replaced?

Code Quality (0-0.3):
- Is the code clean and idiomatic Angular?
- Were unnecessary imports removed?
- Is the component properly typed (no \`any\`)?`,
          weight: 0.3,
        }),
      ],
    },
  ],
});
