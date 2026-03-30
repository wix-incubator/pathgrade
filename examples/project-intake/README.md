# project-intake Example (Conversation Eval)

A conversation eval example showing how to test a multi-turn skill that requires back-and-forth dialogue.

## Structure

```
project-intake/
├── eval.ts                          # TypeScript eval config (defineEval)
├── skill/
│   ├── SKILL.md                     # The project-intake skill being tested
│   ├── .claude-plugin/plugin.json   # Plugin metadata
│   └── agents/openai.yaml           # Agent config
└── graders/
    └── check-brief.js               # Checks artifacts/project-brief-*.md
```

## What's tested

The agent must run the project-intake conversational intake to produce a project brief. Two tasks exercise different reply strategies:

| Task | Reply Strategy | Description |
|------|---------------|-------------|
| `scripted-loyalty-program` | Scripted replies | Pre-defined answers with pattern matching |
| `persona-loyalty-program` | LLM persona (gpt-4o) | Simulated PM provides contextual answers |

Both tasks check that the agent:
1. Conducts a multi-turn conversation (not a monologue)
2. Produces `artifacts/project-brief-*.md`
3. Brief contains required sections: Context, Direction, Goal, Target Group

## Graders

- **Deterministic (50%)** — Node.js grader that checks the brief file exists and has all required sections (5 checks, each worth 0.2)
- **LLM Rubric (50%)** — Evaluates conversation flow, brief quality, and skill compliance

## Prerequisites

- `scripted-loyalty-program`: No extra keys needed (uses the configured agent)
- `persona-loyalty-program`: Requires `OPENAI_API_KEY` (persona uses gpt-4o)

## Run

```bash
pathgrade --smoke
```
