# Tool-Judge Demo

End-to-end example of `judge({ tools: [...] })` — the LLM judge reads
workspace artifacts directly using a bounded tool-use loop instead of the
eval author pre-computing probes.

Parent PRD: [`rfcs/003-judge-with-tools.md`](../../../../rfcs/003-judge-with-tools.md).

## Run it

```bash
ANTHROPIC_API_KEY=sk-... \
  npx vitest run --config examples/tool-judge-demo/vitest.config.mts
```

The test skips cleanly when `ANTHROPIC_API_KEY` is not set.

## Migration pattern

Before (the pain the RFC motivates):

```ts
// scorers/missing-sections.ts
export function missingSpecSections(workspace: string): string[] {
    const body = fs.readFileSync(path.join(workspace, 'artifacts/spec.md'), 'utf8');
    return ['Intent Hierarchy', 'Functional Requirements', 'API Surface']
        .filter((section) => !body.includes(`## ${section}`));
}

// eval.ts
judge('spec-sections', {
    rubric: 'Does the spec have all required sections?',
    input: { missing_sections: missingSpecSections(workspace) },
});
```

The rubric's grading logic lives in two places — the English rubric and the
TypeScript probe — and they drift apart.

After (this example):

```ts
judge('spec-sections', {
    rubric: `Read artifacts/spec.md and grade whether it has Intent Hierarchy,
             Functional Requirements, and API Surface sections.`,
    tools: ['readFile', 'grep'],
});
```

The judge reads the file itself. One source of truth. Prompt caching
(default-on when `tools` is set) keeps the token cost bounded.

## What to look for in the report

After running, open the browser reporter:

```bash
npx pathgrade preview
```

Each tool-using judge shows a `judge_tool_call` log for every tool
invocation — name, arguments, ok/error, bytes returned. The final score's
`details` is the judge LLM's own rationale citing the evidence it read.

## When to use tools vs. not

See the decision table in the USER_GUIDE. Rule of thumb:

- `check()` — deterministic gate you can code up in five lines
- `judge()` without `tools` — prose-quality rubric where the transcript is enough
- `judge({ tools })` — rubric depends on artifacts the agent produced
- `score()` — arbitrary code; the escape hatch
