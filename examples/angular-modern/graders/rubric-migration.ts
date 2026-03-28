import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricMigration = llmRubricGrader({
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
});
