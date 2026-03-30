---
name: pathgrade-setup
description: Sets up and runs Pathgrade evaluation pipelines for Agent Skills. Use when initializing eval configurations, running trials, reviewing results, or integrating with CI. Don't use for writing grader scripts, general test authoring, or unrelated documentation.
---

# Pathgrade Evaluation Setup

## Procedures

### Step 1: Install Pathgrade

1. Verify Node.js 20+ is available.
2. Run `npm i -g pathgrade`.

### Step 2: Initialize an Eval Configuration

1. Navigate to the skill directory. It should contain a `SKILL.md`.
2. Export the relevant API key: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`.
3. Run `pathgrade init`.
4. If `eval.ts` already exists, use `pathgrade init --force`.
5. Without an API key, Pathgrade creates a commented local-only template.

### Step 3: Configure `eval.ts`

1. Read `references/eval-ts-spec.md` for the current schema.
2. Define one or more tasks under `tasks:`.
3. For each task, provide:
   - `name`
   - `instruction`
   - `workspace` files to copy into the trial workspace when needed
   - one or more `graders`
4. Optionally configure `defaults:` for agent, trials, timeout, threshold, and environment limits.

### Step 4: Run Evaluations

1. Choose a preset:
   - `--smoke` for 5 trials
   - `--reliable` for 15 trials
   - `--regression` for 30 trials
2. Run `pathgrade --smoke`.
3. Run a specific eval with `pathgrade --eval=fix-linting`.
4. Run multiple evals with `pathgrade --eval=fix-linting,write-tests`.
5. Run only deterministic graders with `pathgrade --grader=deterministic`.
6. Run only rubric graders with `pathgrade --grader=llm_rubric`.
7. The agent is auto-detected from the API key. Override with `--agent=gemini|claude|codex`.

### Step 5: Review Results

1. Run `pathgrade preview` for the CLI report.
2. Run `pathgrade preview browser` for the browser report.
3. Reports are saved under `$TMPDIR/pathgrade/<skill-name>/results/` unless `--output=DIR` is provided.

### Step 6: Integrate with CI

1. Add a workflow step that installs Pathgrade, enters the skill directory, and runs `pathgrade --regression --ci`.
2. Use `--threshold` when the default pass bar is not strict enough.
3. Read `references/ci-example.md` for a working workflow snippet.

## Error Handling

- If `pathgrade init` fails with `No SKILL.md found`, verify the current directory contains a valid `SKILL.md`.
- If evaluation hangs, inspect the agent CLI and API-key setup first.
- If all trials fail with missing API credentials, confirm the environment variable is exported in the same shell that runs Pathgrade.
