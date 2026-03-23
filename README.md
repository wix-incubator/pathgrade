# Pathgrade

Pathgrade evaluates whether AI agents correctly discover and use your skills.

See [examples/](examples/) for working evals, including [superlint](examples/superlint/) and [angular-modern](examples/angular-modern/).

![Browser Preview](assets/browser-preview.png)

## Quick Start

**Prerequisites**: Node.js 20+

Pathgrade runs locally. Each trial gets its own isolated workspace, home, XDG, and temp directories.

```bash
npm i -g @wix/pathgrade
```

Initialize from a skill directory:

```bash
cd my-skill/
GEMINI_API_KEY=your-key pathgrade init
# Use --force to overwrite an existing eval.yaml
```

Run your evals:

```bash
GEMINI_API_KEY=your-key pathgrade --smoke
```

The agent is auto-detected from your API key:

- `GEMINI_API_KEY` -> Gemini
- `ANTHROPIC_API_KEY` -> Claude
- `OPENAI_API_KEY` -> Codex

Override the agent explicitly with `--agent=claude`, `--agent=gemini`, or `--agent=codex`.

Review results:

```bash
pathgrade preview
pathgrade preview browser
```

Reports are saved to `$TMPDIR/pathgrade/<skill-name>/results/` by default. Override with `--output=DIR`.

## Presets

| Flag | Trials | Use Case |
|------|--------|----------|
| `--smoke` | 5 | Quick capability check |
| `--reliable` | 15 | Reliable pass rate estimate |
| `--regression` | 30 | High-confidence regression detection |

## Options

| Flag | Description |
|------|-------------|
| `--eval=NAME[,NAME]` | Run specific evals by name |
| `--grader=TYPE` | Run only `deterministic` or `llm_rubric` graders |
| `--trials=N` | Override trial count |
| `--parallel=N` | Run trials concurrently |
| `--agent=gemini\|claude\|codex` | Override agent selection |
| `--output=DIR` | Output directory for reports and temp files |
| `--validate` | Verify graders with a reference solution |
| `--ci` | Exit non-zero if pass rate falls below threshold |
| `--threshold=0.8` | Pass rate threshold for `--ci` |
| `--preview` | Show the CLI preview after the run |

## `eval.yaml` Reference

```yaml
version: "1"

# Optional: explicit path to the skill directory
# skill: path/to/my-skill

defaults:
  agent: gemini
  trials: 5
  timeout: 300
  threshold: 0.8
  grader_model: gemini-3-flash-preview
  environment:
    cpus: 2
    memory_mb: 2048

tasks:
  - name: fix-linting-errors
    instruction: |
      Use the provided tool to fix coding-standard violations in app.js.

    workspace:
      - src: fixtures/broken-app.js
        dest: app.js
      - src: bin/superlint
        dest: /usr/local/bin/superlint
        chmod: "+x"

    graders:
      - type: deterministic
        setup: npm install typescript
        run: npx ts-node graders/check.ts
        weight: 0.7
      - type: llm_rubric
        rubric: |
          Did the agent follow the expected workflow and solve the task cleanly?
        model: gemini-2.0-flash
        weight: 0.3

    agent: claude
    trials: 10
    timeout: 600
```

Pathgrade no longer supports `provider` or `docker` fields in `eval.yaml`.

String values for `instruction`, `rubric`, and `run` support file references:

```yaml
instruction: instructions/fix-linting.md
rubric: rubrics/workflow-quality.md
run: graders/check.sh
```

## Graders

Deterministic graders execute a command and parse JSON from stdout:

```yaml
- type: deterministic
  run: bash graders/check.sh
  weight: 0.7
```

Expected output:

```json
{
  "score": 0.67,
  "details": "2/3 checks passed",
  "checks": [
    { "name": "file-created", "passed": true, "message": "Output file exists" },
    { "name": "content-correct", "passed": false, "message": "Missing expected output" }
  ]
}
```

Use `awk` for floating-point arithmetic in shell graders.

Rubric graders score qualitative behavior from the session transcript:

```yaml
- type: llm_rubric
  rubric: |
    Workflow Compliance (0-0.5):
    - Did the agent follow the expected steps?

    Efficiency (0-0.5):
    - Did it avoid unnecessary commands?
  weight: 0.3
```

## CI

Pathgrade is local-first in CI too:

```yaml
- run: |
    npm i -g @wix/pathgrade
    cd skills/superlint
    GEMINI_API_KEY=${{ secrets.GEMINI_API_KEY }} pathgrade --regression --ci
```

## Environment Variables

| Variable | Used by |
|----------|---------|
| `GEMINI_API_KEY` | Gemini agent execution, rubric grading, `pathgrade init` |
| `ANTHROPIC_API_KEY` | Claude agent execution, rubric grading, `pathgrade init` |
| `OPENAI_API_KEY` | Codex agent execution, `pathgrade init` |

Pathgrade also loads `.env` from the skill directory. Persisted logs redact these values automatically.

## Best Practices

- Grade outcomes, not implementation trivia.
- Name expected output files in the instruction if a grader checks for them.
- Validate graders with `--validate` before trusting eval results.
- Start with a few clear tasks before scaling out.

## License

MIT
