import { defineEval } from '../../src/core/define-eval';
import { checkModernApis } from './graders/check-modern-apis';
import { rubricMigration } from './graders/rubric-migration';

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
        rubricMigration,
      ],
    },
  ],
});
