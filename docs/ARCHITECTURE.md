# Pathgrade - Architecture Guide

**Pathgrade** is a CLI tool that evaluates whether AI agents (Gemini, Claude, Codex) correctly discover and use Agent Skills. It runs trials in isolated Docker containers and grades the results using deterministic tests and LLM rubrics.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Project Structure](#2-project-structure)
3. [Data Structures](#3-data-structures)
4. [The `eval.yaml` Configuration](#4-the-evalyaml-configuration)
5. [End-to-End Execution Flow](#5-end-to-end-execution-flow)
6. [Docker Lifecycle](#6-docker-lifecycle)
7. [Grading System](#7-grading-system)
8. [CLI Commands & Flags](#8-cli-commands--flags)
9. [Output & Results](#9-output--results)

---

## 1. High-Level Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         YOU (developer)                          │
│                                                                  │
│   1. Write a SKILL.md (your agent skill)                         │
│   2. Write eval.yaml (test scenarios for that skill)             │
│   3. Run: pathgrade                                             │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                     SKILLGRADE CLI                               │
│                                                                  │
│   Reads eval.yaml → Builds Docker image → Runs N trials         │
│                                                                  │
│   For EACH trial:                                                │
│   ┌────────────────────────────────────────────────────────┐     │
│   │              Docker Container                          │     │
│   │                                                        │     │
│   │   1. AI Agent receives instruction                     │     │
│   │   2. Agent discovers & uses your skill                 │     │
│   │   3. Agent produces output / modifies files            │     │
│   │                                                        │     │
│   │   Then graders run:                                    │     │
│   │   • Deterministic: bash script checks files → score    │     │
│   │   • LLM Rubric: another LLM judges quality → score    │     │
│   └────────────────────────────────────────────────────────┘     │
│                                                                  │
│   Aggregates scores across trials → Report                       │
└──────────────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                        RESULTS                                   │
│                                                                  │
│   pass_rate: 0.80   (average score across trials)                │
│   pass@k:   0.97   (probability ≥1 success in k trials)         │
│   pass^k:   0.33   (probability ALL k trials succeed)            │
└──────────────────────────────────────────────────────────────────┘
```

**What "evaluating a skill" means concretely:**

You have a skill (e.g., a linting tool). You want to know: "If I give an AI agent a task that requires this skill, will the agent find and use it correctly?" Pathgrade answers this by running the agent many times in clean environments and grading the results.

---

## 2. Project Structure

```
src/
├── pathgrade.ts           ← CLI entry point: parses args, routes to commands
│
├── commands/
│   ├── run.ts              ← Main command: loads config, builds Docker, runs trials
│   ├── init.ts             ← Scaffolds eval.yaml (LLM-powered or template)
│   └── preview.ts          ← Displays results (CLI table or browser)
│
├── core/
│   ├── config.ts           ← Loads & validates eval.yaml, resolves file references
│   ├── config.types.ts     ← TypeScript interfaces for eval.yaml schema
│   └── skills.ts           ← Finds SKILL.md files in standard directories
│
├── evalRunner.ts           ← Trial orchestration: setup → agent → grade → cleanup
│
├── agents/
│   ├── registry.ts         ← Factory: "gemini" | "claude" | "codex" → agent instance
│   ├── gemini.ts           ← Wraps: gemini -y --sandbox=none -p "$(cat /tmp/.prompt.md)"
│   ├── claude.ts           ← Wraps: claude "$(cat /tmp/.prompt.md)" --yes --no-auto-update
│   └── codex.ts            ← Wraps: codex --approval-mode full-auto "$(cat /tmp/.prompt.md)"
│
├── providers/
│   ├── docker.ts           ← Docker provider: build image, create/destroy containers
│   └── local.ts            ← Local provider: temp directories (for CI/testing)
│
├── graders/
│   └── index.ts            ← DeterministicGrader (bash → JSON) & LLMGrader (API call)
│
├── reporters/
│   ├── cli.ts              ← Formats results as CLI table
│   └── browser.ts          ← Serves results in browser UI
│
├── analytics/
│   └── engine.ts           ← Calculates Normalized Gain, aggregates reports
│
├── utils/
│   ├── cli.ts              ← ANSI colors, spinners, formatting helpers
│   └── env.ts              ← Parses .env files
│
├── types.ts                ← Core interfaces: TrialResult, EvalReport, BaseAgent, etc.
└── viewer.html             ← Embedded browser UI template
```

**How the files connect:**

```
pathgrade.ts ──parse args──→ commands/run.ts
                                  │
                    ┌─────────────┼──────────────┐
                    ▼             ▼               ▼
              core/config.ts  core/skills.ts  agents/registry.ts
              (load eval.yaml)  (find SKILL.md)  (create agent)
                    │
                    ▼
              evalRunner.ts ─────────────────────────────────┐
                    │                                        │
                    ├──→ providers/docker.ts (or local.ts)   │
                    │      • prepare()  → build image        │
                    │      • setup()    → create container   │
                    │      • cleanup()  → destroy container  │
                    │      • teardown() → remove image       │
                    │                                        │
                    └──→ graders/index.ts                    │
                           • DeterministicGrader.grade()     │
                           • LLMGrader.grade()               │
                                                             │
                    ◄────────── EvalReport ──────────────────┘
                    │
                    ▼
              reporters/cli.ts (or browser.ts)
```

---

## 3. Data Structures

### 3.1 Configuration Types (what you write in eval.yaml)

These types live in `src/core/config.types.ts`:

```
EvalConfig                          ← Top-level eval.yaml
├── version: string                 ← Always "1"
├── skill?: string                  ← Path to SKILL.md (optional, auto-detected)
├── defaults: EvalDefaults          ← Global defaults for all tasks
│   ├── agent: string               ← "gemini" | "claude" | "codex"
│   ├── provider: string            ← "docker" | "local"
│   ├── trials: number              ← How many times to run each task
│   ├── timeout: number             ← Seconds before killing the agent
│   ├── threshold: number           ← Pass/fail threshold for --ci mode
│   ├── grader_model?: string       ← Default LLM model for rubric grading
│   ├── docker: DockerConfig
│   │   ├── base: string            ← Docker base image (e.g., "node:20-slim")
│   │   └── setup?: string          ← Extra shell commands during image build
│   └── environment: EnvironmentConfig
│       ├── cpus: number            ← CPU limit per container
│       └── memory_mb: number       ← Memory limit per container
│
└── tasks: EvalTaskConfig[]         ← List of evaluation scenarios
    ├── name: string                ← Unique task identifier
    ├── instruction: string         ← What to tell the agent (inline or file path)
    ├── workspace?: WorkspaceMapping[]
    │   ├── src: string             ← Local file to copy into container
    │   ├── dest: string            ← Where it goes in the container
    │   └── chmod?: string          ← Permission change (e.g., "+x")
    ├── graders: EvalGraderConfig[]
    │   ├── type: string            ← "deterministic" or "llm_rubric"
    │   ├── setup?: string          ← Install deps during image build
    │   ├── run?: string            ← Shell script (deterministic only)
    │   ├── rubric?: string         ← Rubric text/file (llm_rubric only)
    │   ├── model?: string          ← LLM model override
    │   └── weight: number          ← How much this grader counts
    └── [overrides]                 ← agent, provider, trials, timeout, docker, etc.
```

### 3.2 Runtime Types (what flows through the system during execution)

These types live in `src/types.ts`:

```
EvalReport                          ← Final output per task
├── task: string                    ← Task name
├── pass_rate: number               ← Average reward across all trials (0.0–1.0)
├── pass_at_k: number               ← P(≥1 success in k trials)
├── pass_pow_k: number              ← P(all k trials succeed)
├── skills_used: string[]           ← Which skills were injected
└── trials: TrialResult[]           ← Individual trial results
    ├── trial_id: number
    ├── reward: number              ← Weighted score (0.0–1.0)
    ├── duration_ms: number
    ├── n_commands: number          ← Commands the agent ran
    ├── input_tokens: number        ← Estimated from instruction length
    ├── output_tokens: number       ← Estimated from agent output
    ├── grader_results: GraderResult[]
    │   ├── grader_type: string     ← "deterministic" or "llm_rubric"
    │   ├── score: number           ← 0.0–1.0
    │   ├── weight: number
    │   └── details: string         ← Human-readable explanation
    └── session_log: LogEntry[]     ← Full execution trace
        ├── type: "agent_start"     ← + instruction
        ├── type: "command"         ← + command, stdout, stderr, exitCode
        ├── type: "agent_result"    ← + output (agent's full response)
        ├── type: "grader"          ← + grader_result
        └── type: "reward"          ← + value (final score)
```

### 3.3 How Config Becomes Runtime Data

```
eval.yaml (on disk)
    │
    │  loadEvalConfig()     ← parse YAML, validate schema
    ▼
EvalConfig (raw config)
    │
    │  resolveTask()        ← merge defaults + per-task overrides
    │                       ← resolve file paths → inline content
    ▼
ResolvedTask (ready to execute)
    │
    │  EvalRunner.runEval() ← run N trials, collect results
    ▼
EvalReport (final output)
    │
    │  saveReport()         ← write JSON to disk
    ▼
results/<task>_<timestamp>.json
```

**Example of file resolution:** The `instruction` field can be either inline text or a file path. `resolveFileOrInline()` decides:

```
instruction: "Fix the linting errors in app.js"     → inline (no file read)
instruction: instructions/fix-lint.md                → reads file contents
instruction: |                                       → inline (has newlines)
  Fix the linting errors in app.js.
  Use the superlint tool.
```

---

## 4. The `eval.yaml` Configuration

### 4.1 Complete Example

```yaml
version: "1"

# Optional: explicit path to the skill being tested.
# If omitted, pathgrade auto-detects SKILL.md files in:
#   ./SKILL.md, ./skills/*, ./.agents/skills/*, ./.claude/skills/*
skill: ./skills/superlint

defaults:
  agent: gemini               # Which AI agent to test with
  provider: docker            # Run in Docker (vs "local" for temp dirs)
  trials: 5                   # Run each task 5 times
  timeout: 300                # Kill agent after 5 minutes
  threshold: 0.8              # CI fails if pass_rate < 80%
  grader_model: gemini-2.0-flash   # Default model for LLM graders
  docker:
    base: node:20-slim        # Base Docker image
    setup: |                  # Extra setup commands
      apt-get update && apt-get install -y jq
  environment:
    cpus: 2
    memory_mb: 2048

tasks:
  - name: fix-linting
    # The instruction the AI agent receives:
    instruction: |
      The file app.js has linting errors. Find and use the superlint
      tool to fix them. Do not fix errors manually.

    # Files copied into the container before the agent runs:
    workspace:
      - src: fixtures/broken-app.js      # Local file
        dest: app.js                      # Path in container (/workspace/app.js)
      - src: bin/superlint                # Local executable
        dest: /usr/local/bin/superlint    # Absolute path in container
        chmod: "+x"                       # Make executable

    # How to score the agent's work:
    graders:
      - type: deterministic
        run: |
          #!/bin/bash
          # Check if app.js was actually fixed
          ERRORS=$(node -c app.js 2>&1 | grep -c "SyntaxError" || true)
          USED_TOOL=$(grep -c "superlint" /workspace/.command_history 2>/dev/null || echo "0")

          if [ "$ERRORS" = "0" ] && [ "$USED_TOOL" -gt "0" ]; then
            echo '{"score": 1.0, "details": "All errors fixed using superlint"}'
          elif [ "$ERRORS" = "0" ]; then
            echo '{"score": 0.5, "details": "Errors fixed but superlint not used"}'
          else
            echo '{"score": 0.0, "details": "Linting errors remain"}'
          fi
        weight: 1.0

      - type: llm_rubric
        rubric: |
          Score the agent on:
          1. Did it discover the superlint skill? (0.3)
          2. Did it invoke superlint correctly? (0.4)
          3. Was the workflow efficient (minimal unnecessary steps)? (0.3)
        weight: 0.5

  - name: multi-file-lint
    instruction: instructions/multi-file.md   # Load from file
    workspace:
      - src: fixtures/project/
        dest: project/
    graders:
      - type: deterministic
        setup: npm install -g eslint         # Install during image build
        run: bash graders/check-multi.sh
        weight: 1.0
    # Per-task overrides:
    trials: 10
    timeout: 600
    agent: claude                            # Use Claude instead of Gemini
```

### 4.2 Config Resolution Flow

When you define a task, defaults are merged with per-task overrides:

```
defaults:                    task override:           resolved result:
  agent: gemini              agent: claude      →     agent: claude        (overridden)
  trials: 5                  trials: 10         →     trials: 10           (overridden)
  timeout: 300               (not set)          →     timeout: 300         (from defaults)
  docker:                    (not set)          →     docker:
    base: node:20-slim                                  base: node:20-slim (from defaults)
```

---

## 5. End-to-End Execution Flow

### 5.1 `pathgrade run` — The Main Flow

```
$ pathgrade --trials 5 --agent gemini

┌─────────────────────────────────────────────────────────────────┐
│ Phase 1: LOAD                                                   │
│                                                                 │
│ pathgrade.ts                                                   │
│   │  parse CLI args (--trials=5, --agent=gemini, etc.)          │
│   ▼                                                             │
│ commands/run.ts: runEvals()                                     │
│   │                                                             │
│   ├── loadEvalConfig(".")     → parse eval.yaml                 │
│   ├── detectSkills(".")       → find SKILL.md files             │
│   ├── loadEnvFile(".env")     → load API keys                   │
│   └── auto-detect agent       → if only 1 API key, use that    │
│                                                                 │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼  (for each task in eval.yaml)
┌─────────────────────────────────────────────────────────────────┐
│ Phase 2: PREPARE                                                │
│                                                                 │
│ resolveTask()                                                   │
│   │  merge defaults + task overrides                            │
│   │  resolve file paths → inline content                        │
│   ▼                                                             │
│ prepareTempTaskDir()                                            │
│   │  create temp directory with:                                │
│   │    environment/Dockerfile                                   │
│   │    tests/test.sh (deterministic grader scripts)             │
│   │    prompts/quality.md (LLM rubrics)                         │
│   │    workspace files (fixtures, etc.)                         │
│   ▼                                                             │
│ DockerProvider.prepare()                                        │
│   │  docker build → base image                                  │
│   │  inject skills into .agents/skills/ and .claude/skills/     │
│   │  docker commit → prepared image (reused for all trials)     │
│   ▼                                                             │
│ Result: Docker image "pathgrade-fix-linting-ready"             │
│                                                                 │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼  (repeated N times — one per trial)
┌─────────────────────────────────────────────────────────────────┐
│ Phase 3: TRIAL (× 5)                                            │
│                                                                 │
│ ┌─── Trial 1 ──────────────────────────────────────────────┐    │
│ │                                                          │    │
│ │  3a. SETUP                                               │    │
│ │  DockerProvider.setup()                                  │    │
│ │    → docker create container from prepared image         │    │
│ │    → set env vars (API keys), resource limits            │    │
│ │    → docker start                                        │    │
│ │                                                          │    │
│ │  3b. AGENT EXECUTION                                     │    │
│ │  agent.run(instruction, workspace, runCommand)           │    │
│ │    → write instruction to /tmp/.prompt.md                │    │
│ │    → exec: gemini -y --sandbox=none -p "$(cat ...)"      │    │
│ │    → agent runs inside container, reads/writes files     │    │
│ │    → agent discovers skill in .agents/skills/            │    │
│ │    → returns stdout (agent's response/actions)           │    │
│ │    → timeout: kills agent after N seconds                │    │
│ │                                                          │    │
│ │  3c. GRADING                                             │    │
│ │  For each grader in task.graders:                        │    │
│ │    ┌─ deterministic ─────────────────────────────────┐   │    │
│ │    │  exec: bash tests/test.sh (inside container)    │   │    │
│ │    │  parse JSON from stdout → { score, details }    │   │    │
│ │    └─────────────────────────────────────────────────┘   │    │
│ │    ┌─ llm_rubric ────────────────────────────────────┐   │    │
│ │    │  build prompt: rubric + session transcript       │   │    │
│ │    │  call Gemini/Anthropic API → { score, reasoning }│  │    │
│ │    └─────────────────────────────────────────────────┘   │    │
│ │                                                          │    │
│ │  3d. SCORING                                             │    │
│ │  reward = Σ(score × weight) / Σ(weight)                  │    │
│ │                                                          │    │
│ │  Example:                                                │    │
│ │    deterministic: score=1.0, weight=1.0                  │    │
│ │    llm_rubric:    score=0.7, weight=0.5                  │    │
│ │    reward = (1.0×1.0 + 0.7×0.5) / (1.0 + 0.5) = 0.90   │    │
│ │                                                          │    │
│ │  3e. CLEANUP                                             │    │
│ │  DockerProvider.cleanup()                                │    │
│ │    → docker kill + remove container                      │    │
│ │    → image stays (reused for next trial)                 │    │
│ │                                                          │    │
│ └──────────────────────────────────────────────────────────┘    │
│                                                                 │
│ ... Trial 2, 3, 4, 5 (same flow, fresh container each time)    │
│                                                                 │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│ Phase 4: AGGREGATE & REPORT                                     │
│                                                                 │
│ Calculate statistics across all 5 trials:                       │
│   pass_rate = mean(rewards)         → e.g., 0.80               │
│   pass@k   = P(≥1 success in k)    → e.g., 0.97               │
│   pass^k   = P(all k succeed)      → e.g., 0.33               │
│                                                                 │
│ Sanitize: redact API keys from session logs                     │
│ Save: $TMPDIR/pathgrade/<skill>/results/<task>_<timestamp>.json│
│                                                                 │
│ DockerProvider.teardown()                                       │
│   → docker rmi (remove prepared image)                          │
│                                                                 │
│ If --ci: exit 1 if pass_rate < threshold                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Concrete Example: What Happens In a Single Trial

Let's trace trial #1 of the `fix-linting` task with Gemini:

```
1. Container created from prepared image
   ├── /workspace/app.js              ← broken file (from fixtures/)
   ├── /workspace/.agents/skills/superlint/SKILL.md  ← injected skill
   ├── /workspace/.claude/skills/superlint/SKILL.md  ← same skill (for Claude)
   ├── /workspace/tests/test.sh       ← deterministic grader script
   ├── /workspace/prompts/quality.md  ← LLM rubric
   └── /usr/local/bin/superlint       ← tool binary (from workspace mapping)

2. Agent receives instruction:
   "The file app.js has linting errors. Find and use the superlint
    tool to fix them. Do not fix errors manually."

3. Agent execution (gemini CLI inside container):
   $ gemini -y --sandbox=none -p "$(cat /tmp/.prompt.md)"

   Agent thinks → discovers SKILL.md → reads it → runs superlint → fixes app.js

   Agent output captured as session log entries:
     [command] ls .agents/skills/          → stdout: "superlint"
     [command] cat .agents/skills/superlint/SKILL.md → stdout: "..."
     [command] superlint app.js            → stdout: "Fixed 3 errors"

4. Deterministic grader runs:
   $ bash tests/test.sh
   → checks app.js is valid, checks superlint was used
   → stdout: {"score": 1.0, "details": "All errors fixed using superlint"}

5. LLM grader runs:
   → sends session transcript + rubric to Gemini API
   → response: {"score": 0.8, "reasoning": "Agent found and used skill efficiently"}

6. Final reward:
   (1.0 × 1.0 + 0.8 × 0.5) / (1.0 + 0.5) = 0.93

7. Container killed and removed
```

---

## 6. Docker Lifecycle

### 6.1 Image Build (One-Time Per Task)

```
prepareTempTaskDir() creates:          DockerProvider.prepare() does:

tmp/fix-linting/                       ┌──────────────────────────────┐
├── environment/                       │  docker build                │
│   └── Dockerfile ─────────────────►  │    FROM node:20-slim         │
├── tests/                             │    WORKDIR /workspace        │
│   └── test.sh                        │    RUN npm install -g        │
├── prompts/                           │        @google/gemini-cli    │
│   └── quality.md                     │    RUN apt-get install jq    │
├── app.js (workspace file)            │    COPY app.js app.js        │
└── superlint (workspace file)         │    COPY . .                  │
                                       │    CMD ["bash"]              │
                                       └──────────┬───────────────────┘
                                                  │
                                                  ▼ base image
                                       ┌──────────────────────────────┐
                                       │  Inject skills               │
                                       │                              │
                                       │  1. Create temp container    │
                                       │  2. mkdir -p                 │
                                       │     /workspace/.agents/skills│
                                       │     /workspace/.claude/skills│
                                       │  3. TAR + copy each skill    │
                                       │     into both directories    │
                                       │  4. docker commit            │
                                       │     → "pathgrade-*-ready"   │
                                       │  5. Remove temp container    │
                                       └──────────┬───────────────────┘
                                                  │
                                                  ▼ prepared image
                                       (reused across all N trials)
```

### 6.2 Container Lifecycle (Per Trial)

```
                    ┌─────────────────────────────────────────┐
   setup()          │  docker create from prepared image      │
                    │  + env: GEMINI_API_KEY=sk-...           │
                    │  + limits: 2 CPUs, 2048 MB              │
                    │  docker start                           │
                    └────────────────┬────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────────┐
   agent.run()      │  docker exec: gemini -y --sandbox=none  │
                    │    -p "$(cat /tmp/.prompt.md)"           │
                    │                                         │
                    │  (agent runs, may take 1-300 seconds)   │
                    │  (all commands logged via runCommand)    │
                    └────────────────┬────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────────┐
   graders.grade()  │  docker exec: bash tests/test.sh        │
                    │  (or: LLM API call with session log)    │
                    └────────────────┬────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────────┐
   cleanup()        │  docker kill container                  │
                    │  docker rm container                    │
                    │  (image preserved for next trial)       │
                    └─────────────────────────────────────────┘
```

### 6.3 Why Skills Are Injected Into Two Directories

Different AI agents look for skills in different places:

```
/workspace/.agents/skills/superlint/SKILL.md   ← Gemini looks here
/workspace/.claude/skills/superlint/SKILL.md   ← Claude looks here
```

Pathgrade copies skills into **both** directories so the same image works regardless of which agent is being tested.

### 6.4 Local Provider (Alternative to Docker)

For CI/testing, the `local` provider skips Docker entirely:

```
setup()    → cp -r taskPath /tmp/pathgrade-XXXXX/
             cp -r skills into .agents/skills/ and .claude/skills/
run()      → spawn child process with shell: true, cwd = tempDir
cleanup()  → rm -rf /tmp/pathgrade-XXXXX/
```

No image build, no containers. Everything runs directly on the host.

---

## 7. Grading System

### 7.1 Deterministic Grader

Runs a shell script inside the container and expects JSON on stdout.

```
┌─ Your grader script (test.sh) ─────────────────────────────────┐
│                                                                 │
│  #!/bin/bash                                                    │
│  # Check whatever you want about the workspace                 │
│  # Output MUST be JSON to stdout                                │
│                                                                 │
│  echo '{"score": 0.67, "details": "2/3 checks passed",         │
│         "checks": [                                             │
│           {"name": "file_exists", "passed": true,               │
│            "message": "app.js exists"},                         │
│           {"name": "no_errors", "passed": true,                 │
│            "message": "No syntax errors"},                      │
│           {"name": "used_tool", "passed": false,                │
│            "message": "superlint was not invoked"}              │
│         ]}'                                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ DeterministicGrader.grade() ──────────────────────────────────┐
│                                                                 │
│  1. Run: bash tests/test.sh (inside container)                  │
│  2. Extract JSON from stdout (regex: /\{[\s\S]*\}/)            │
│  3. Parse score (clamped 0.0–1.0), details, checks             │
│  4. Return GraderResult { score: 0.67, details: "..." }        │
│                                                                 │
│  If no JSON in stdout → score = 0                               │
│  If JSON parse fails  → score = 0                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 LLM Rubric Grader

Sends the full session transcript to an LLM and asks it to score against a rubric.

```
┌─ Input: session transcript + rubric ───────────────────────────┐
│                                                                 │
│  ## Rubric                                                      │
│  Score the agent on:                                            │
│  1. Did it discover the superlint skill? (0.3)                  │
│  2. Did it invoke superlint correctly? (0.4)                    │
│  3. Was the workflow efficient? (0.3)                            │
│                                                                 │
│  ## Session Transcript                                          │
│  ### Task Instruction                                           │
│  Fix the linting errors in app.js...                            │
│                                                                 │
│  ### Commands Executed                                          │
│  $ ls .agents/skills/                                           │
│  superlint                                                      │
│  [exit code: 0]                                                 │
│                                                                 │
│  $ superlint app.js                                             │
│  Fixed 3 errors                                                 │
│  [exit code: 0]                                                 │
│                                                                 │
│  ### Agent Output                                               │
│  I found the superlint skill and used it to fix app.js...       │
│                                                                 │
│  ### Prior Grader Results (automated tests)                     │
│  - deterministic: score=1.00 — All errors fixed using superlint │
│                                                                 │
└─────────────────────────────────────┬───────────────────────────┘
                                      │
                                      ▼
┌─ LLMGrader.grade() ───────────────────────────────────────────┐
│                                                                 │
│  1. Build prompt with rubric + transcript (shown above)         │
│  2. Call LLM API:                                               │
│     • Try Gemini first (if GEMINI_API_KEY exists)               │
│       Model: config.model || "gemini-3-flash-preview"           │
│     • Fall back to Anthropic (if ANTHROPIC_API_KEY exists)      │
│       Model: config.model || "claude-sonnet-4-20250514"         │
│  3. Parse response: {"score": 0.85, "reasoning": "..."}        │
│  4. Return GraderResult { score: 0.85, details: "..." }        │
│                                                                 │
│  Robustness: if JSON parse fails, tries regex for "score": N   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 Weight-Based Score Combination

Multiple graders are combined using weighted average:

```
Example: 2 graders on a task
┌────────────────┬───────┬────────┬──────────────────────┐
│ Grader         │ Score │ Weight │ Contribution         │
├────────────────┼───────┼────────┼──────────────────────┤
│ deterministic  │ 1.0   │ 1.0    │ 1.0 × 1.0 = 1.00    │
│ llm_rubric     │ 0.7   │ 0.5    │ 0.7 × 0.5 = 0.35    │
├────────────────┼───────┼────────┼──────────────────────┤
│ TOTAL          │       │ 1.5    │ 1.35                 │
│ REWARD         │       │        │ 1.35 / 1.5 = 0.90   │
└────────────────┴───────┴────────┴──────────────────────┘
```

### 7.4 Statistical Metrics Across Trials

After all trials complete, three metrics are calculated:

```
Given: 5 trials with rewards [1.0, 0.9, 0.0, 0.85, 0.95]
Success threshold: reward ≥ 0.5
Successes: 4, Failures: 1

pass_rate = mean(rewards) = (1.0 + 0.9 + 0.0 + 0.85 + 0.95) / 5 = 0.74

pass@k = 1 - C(failures, k) / C(n, k)
       = 1 - C(1, 5) / C(5, 5)
       = 1 - 0 = 1.0
       "Probability of at least 1 success if you run 5 trials"

pass^k = (successes / n) ^ k
       = (4/5) ^ 5
       = 0.33
       "Probability that ALL 5 trials succeed"
```

---

## 8. CLI Commands & Flags

### 8.1 `pathgrade` (default = run)

```
pathgrade [options]

Options:
  --smoke              5 trials (quick check)
  --reliable          15 trials (estimate pass rate)
  --regression        30 trials (high-confidence regression detection)
  --trials=N          Override trial count
  --parallel=N        Run N trials concurrently
  --agent=NAME        gemini | claude | codex (override eval.yaml)
  --provider=NAME     docker | local (override eval.yaml)
  --eval=NAME[,NAME]  Run specific tasks by name
  --grader=TYPE       Filter: deterministic | llm_rubric
  --output=DIR        Output directory (default: $TMPDIR/pathgrade)
  --validate          Run reference solution to verify graders work
  --ci                Exit non-zero if below threshold
  --threshold=N       Pass rate threshold for --ci (default: from eval.yaml)
  --preview           Show CLI results table after running
```

**Examples:**

```bash
# Quick smoke test with Gemini
pathgrade --smoke

# Full regression test with Claude, 30 trials
pathgrade --regression --agent claude

# Run only the "fix-linting" task, 10 trials in parallel
pathgrade --eval fix-linting --trials 10 --parallel 4

# CI mode: fail pipeline if pass rate < 90%
pathgrade --reliable --ci --threshold 0.9

# Validate that your graders work (runs reference solution)
pathgrade --validate

# Test only deterministic graders (skip expensive LLM calls)
pathgrade --smoke --grader deterministic
```

### 8.2 `pathgrade init`

```
pathgrade init [--force]

Scaffolds an eval.yaml by:
1. Detecting SKILL.md files in standard locations
2. Trying LLM-powered generation (uses Gemini/Anthropic/OpenAI API)
3. Falling back to a template if no API key available
```

### 8.3 `pathgrade preview`

```
pathgrade preview           # CLI table of latest results
pathgrade preview browser   # Web UI at http://localhost:3847
```

---

## 9. Output & Results

### 9.1 Output Directory Structure

```
$TMPDIR/pathgrade/<skill-name>/
├── results/
│   ├── fix-linting_2026-03-19T10-30-00-000Z.json
│   ├── fix-linting_2026-03-19T11-00-00-000Z.json
│   └── multi-file-lint_2026-03-19T10-30-00-000Z.json
└── tmp/                     ← temp build dirs (cleaned up after run)
```

### 9.2 Result JSON Example

```json
{
  "task": "fix-linting",
  "pass_rate": 0.80,
  "pass_at_k": 0.97,
  "pass_pow_k": 0.33,
  "skills_used": ["superlint"],
  "trials": [
    {
      "trial_id": 1,
      "reward": 0.93,
      "duration_ms": 45200,
      "n_commands": 5,
      "input_tokens": 62,
      "output_tokens": 1250,
      "grader_results": [
        {
          "grader_type": "deterministic",
          "score": 1.0,
          "weight": 1.0,
          "details": "All errors fixed using superlint\n  ✓ file_exists: app.js exists\n  ✓ no_errors: No syntax errors\n  ✓ used_tool: superlint was invoked"
        },
        {
          "grader_type": "llm_rubric",
          "score": 0.85,
          "weight": 0.5,
          "details": "Agent efficiently discovered and used superlint skill"
        }
      ],
      "session_log": [
        {
          "type": "agent_start",
          "timestamp": "2026-03-19T10:30:00.000Z",
          "instruction": "The file app.js has linting errors..."
        },
        {
          "type": "command",
          "timestamp": "2026-03-19T10:30:05.000Z",
          "command": "ls .agents/skills/",
          "stdout": "superlint\n",
          "stderr": "",
          "exitCode": 0
        },
        {
          "type": "command",
          "timestamp": "2026-03-19T10:30:12.000Z",
          "command": "superlint app.js",
          "stdout": "Fixed 3 errors in app.js\n",
          "stderr": "",
          "exitCode": 0
        },
        {
          "type": "agent_result",
          "timestamp": "2026-03-19T10:30:15.000Z",
          "output": "I found the superlint skill and used it to fix..."
        },
        {
          "type": "grader",
          "timestamp": "2026-03-19T10:30:20.000Z",
          "grader_result": { "grader_type": "deterministic", "score": 1.0, "..." : "..." }
        },
        {
          "type": "reward",
          "timestamp": "2026-03-19T10:30:25.000Z",
          "value": 0.93
        }
      ]
    }
  ]
}
```

### 9.3 Security: API Key Redaction

Before saving results, all env var values (API keys, etc.) are scrubbed from session logs:

```
Before: "stdout": "Using key sk-abc123..."
After:  "stdout": "Using key [REDACTED]..."
```

---

## Environment Variables

| Variable | Used By | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Agent (Gemini), LLM grader, `pathgrade init` | Gemini API access |
| `ANTHROPIC_API_KEY` | Agent (Claude), LLM grader, `pathgrade init` | Anthropic API access |
| `OPENAI_API_KEY` | Agent (Codex), `pathgrade init` | OpenAI API access |
| `NO_COLOR` | CLI formatting | Disable ANSI colors |

Can be set via process environment or a `.env` file in the project root.

---

## Timeouts & Resource Limits

| Setting | Default | Configurable Via |
|---|---|---|
| Agent timeout | 300s | `defaults.timeout` or `task.timeout` |
| Grader timeout | 120s | `EvalRunOptions.graderTimeoutSec` |
| Container CPUs | 2 | `defaults.environment.cpus` |
| Container memory | 2048 MB | `defaults.environment.memory_mb` |
