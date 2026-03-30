---
name: ck-product-strategy
description: Shapes product strategy (target audience, problem statement, intents and feelings, solution statement, why now and business impact, business KPIs). Scans for project brief and research artifacts, then works section-by-section with validation and iteration. Use when the user wants to shape product strategy, validate direction, align stakeholders, or invokes /ck-product-strategy; when a project brief or discovery research is present or will be provided.
disable-model-invocation: true
metadata:
  phase: product-sculpting
  inputs: artifacts/project-brief-*.md, artifacts/discovery/*
  outputs: artifacts/product/product-strategy-{project-name}.md
---

<!-- ck:ext-loading -->
Run `node ~/.agents/skills/ck-shared/scripts/load-ext.js ck-product-strategy` before executing any workflow step. If it outputs content, apply it as additional guidance (additive, not replacement). If no output, proceed normally.
<!-- /ck:ext-loading -->

# Product Strategy

Helps Creators shape product strategy so they can **validate direction**, **align stakeholders**, and make **confident high-level decisions** before investing in detailed specifications and development.

## Inputs

**Primary inputs (required):**

- **Project brief** — main context for the feature or problem
- **Research artifacts** — one artifact per research type: user voice, data, competitors, internal, terminology (from `artifacts/discovery/`)

**Fallbacks (when primary inputs are missing or incomplete):**

- **Manual input** — user-provided context in chat
- **Assumptions** — LLM infers and states assumptions when information is missing

## Outputs

A **Product strategy** document with these sections:

| Section | Scope |
|--------|--------|
| Target audience | Who the product serves |
| Problem statement | What problem is being solved |
| Intents and feelings | User intents and emotional drivers |
| Solution statement | High-level solution direction |
| Why now & business impact | Timing and business rationale |
| Business KPIs | Success metrics |

**How to create each section and expected format:** For every section, follow the Method, Guidelines, Structure, and Output requirements in [reference.md](reference.md) for that section.

**Output path:** `artifacts/product/product-strategy-{project-name}.md`

**Final deliverable:** One markdown file at that path, with all sections in order, each following the format defined in [reference.md](reference.md): Target audience, Problem statement, Intents and feelings, Solution statement, Product solution summary, Why now & business impact, Business KPIs.

---

## When to Apply

- User says they want to shape product strategy or validate direction
- User invokes **/ck-product-strategy**


---

## Workflow

Work through the journey **in order**. Work on **one section at a time**. Do not move to the next section until the current one is approved.

When **drafting** a section, read and apply the corresponding **"How to Define"** guide in [reference.md](reference.md): Method, Guidelines, Structure, and Output requirements. Use the expected format so the output is consistent.

| Step | Section | Reference section |
|------|---------|-------------------|
| 1 | Target audience | Target Audience — How to Define |
| 2 | Problem statement | Problem Statement — How to Define |
| 3 | Intents and feelings | Intents & Feelings — How to Define |
| 4 | Solution statement | Solution Statement — How to Define |
| 4b | Product solution summary | Product Solution Summary — How to Define |
| 5 | Why now & impact + KPIs | Why Now & Impact — How to Define + KPIs — How to Define |

### Step 0: Setup and validation

1. **Scan for inputs** (walk up directory tree from cwd):
   - `artifacts/project-brief-*.md` — project brief (primary)
   - `artifacts/discovery/` — research artifacts: user voice, data, competitors, internal, terminology (one or more artifact files per type)
   - `artifacts/discovery/research-summary-*.md` — consolidated research summary (when present, use as a high-quality starting point — it synthesizes findings across research types)
   - `artifacts/discovery/data-analysis-*.md` — quantified data analysis (use for sizing, baselines, and evidence in Steps 1 and 5)
2. **Confirm intent:** Use the ask-user tool to confirm the user wants to start (or continue) working on the strategy:
   - "Start strategy from scratch"
   - "Continue from where we left off"
3. **Present inputs summary.** Start with 1–2 sentences of project context extracted from the brief (what the project is about), then list which research artifacts were found. Follow these rules:
   - **Flag missing research explicitly.** The expected research types are: user voice, competitors, internal discovery, data, terminology. If any are missing, call them out by name — don't silently omit them.
   - **Keep it simple.** Show artifact names only (e.g., "User voice report", "Competitor analysis") — no full file paths.
   - **No redundant text.** Don't repeat what the list already shows. No "Phase outputs: None found yet" or similar filler.
   - Do not list annual plan here — it is checked in Step 5.
   - If anything critical is missing, use the ask-user tool to ask how to proceed:
     - "I'll add the missing input — give me a moment"
     - "Proceed with assumptions"

---

### Step 1: Target audience

1. **Gather** — Use project brief, research, and any user input. When data analysis (`data-analysis-*.md`) or research summary (`research-summary-*.md`) exists, use population sizes and segment data to inform who the audience is and why they matter. When the project brief has Domain References with KB IDs, query the domain KB for known audience segments and their business characteristics.
2. **Decide** — If you have enough information → draft. If not → ask clarification questions; do not draft until gaps are filled or user accepts assumptions.
3. **Draft** — Generate the Target audience section using the method, guidelines, and structure in [reference.md](reference.md) (Target Audience — How to Define). Include both product relevance (who has the problem) and business relevance (why this segment matters to Wix).
4. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
5. **Iterate** until the user approves. Only then move to Step 2.

---

### Step 2: Problem statement

1. **Gather** — Use approved Target audience plus project brief, research, and user input.
2. **Clarify if needed** — Ask questions if the problem is unclear.
3. **Draft** — Generate the Problem statement section using [reference.md](reference.md) (Problem Statement — How to Define). Use 5 Whys; show the chain to the user before finalizing; output Problem, Root Cause, Opportunity.
4. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
5. **Iterate** until the user approves. Only then move to Step 3.

---

### Step 3: Intents and feelings

1. **Gather** — Use approved Target audience and Problem statement plus research and user input.
2. **Clarify if needed** — Ask questions if intents or feelings are unclear.
3. **Draft** — Generate the Intents and feelings section using [reference.md](reference.md) (Intents & Feelings — How to Define). First-person intents; Main + Sub-Intents; Current/Expected Feelings; priorities.
4. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
5. **Iterate** until the user approves. Only then move to Step 4.

---

### Step 4: Solution statement

1. **Gather** — Use all approved sections so far (Target audience, Problem statement, Intents and feelings) plus any additional context.
2. **Clarify if needed** — Ask questions if the solution direction is unclear.
3. **Draft** — Generate the Solution statement section using [reference.md](reference.md) (Solution Statement — How to Define). One concise sentence; direction only, no features/UI.
4. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
5. **Iterate** until the user approves. Only then move to Step 4b.

---

### Step 4b: Product solution summary

After the Solution Statement is approved, crystallize the product solution into a concrete, plain-language summary. This is NOT the abstract solution direction — it's the "here's what we're actually building" moment.

1. **Draft** — Generate the Product solution summary using [reference.md](reference.md) (Product Solution Summary — How to Define). Use all approved sections plus any research/current-impl context available.
2. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
3. **Iterate** until the user approves. Only then move to Step 5.

---

### Step 5: Why now & business impact + Business KPIs

Reference file: [annual-plan.md](annual-plan.md)

1. **Annual plan** — Look for `annual-plan.md` in the workspace (e.g. project root or artifacts). If not found, tell the user and use the ask-user tool:
   - "I'll add the annual plan — give me a moment"
   - "Proceed without it"
   Do not draft Why Now until the user has decided or added the file.
2. **Domain gameplan** — Check the project brief for a `## Domain Gameplan` section with a link. If found, fetch and use it. If not found, ask the user whether they have a domain gameplan link to share; use only what they provide.
3. **Gather** — Use all approved sections, business context, the annual plan (from `annual-plan.md` if present), and any company gameplan the user provided. When data analysis (`data-analysis-*.md`) or research summary (`research-summary-*.md`) exists in discovery artifacts, use quantified findings as evidence for "Why Now" and as baselines for KPIs. If the project brief has Domain References with KB IDs, query the domain KB for strategic context (e.g., domain priorities, known gaps).
4. **Clarify if needed** — Ask about timing, business impact, and desired KPIs.
5. **Draft** — Generate Why now & business impact and Business KPIs using [reference.md](reference.md) (Why Now & Impact — How to Define; KPIs — How to Define). Why Now: 1–2 sentences, evidence-based; align with Wix plan when available. KPIs: Business KPIs + User KPIs lists; measurable, with direction (↑/↓); never NPS. When data artifacts provide baselines, include them next to each KPI.
6. **Sanity check** — After drafting KPIs, do a light review: are they measurable, clearly directional, and non-overlapping? Fix any vague or redundant KPIs before sharing with user. (This is product-level validation, not a full metric query review.)
7. **Share** — Present draft then use the ask-user tool:
   - "Looks good — continue"
   - "I have feedback"
8. **Iterate** until the user approves.
9. **Final deliverable** — Compile all approved sections into `artifacts/product/product-strategy-{project-name}.md`, creating the directory if needed. Include sections in order, each in the format defined in [reference.md](reference.md). After saving, read the file back and confirm to the user: `Saved to: artifacts/product/product-strategy-{project-name}.md`. Strategy complete.

---

## Conventions

- **One section at a time** — No jumping ahead until the current section is approved.
- **Explicit assumptions** — When inferring, state: "Assuming X; correct or add details."
- **Concise questions** — Ask only what's needed to draft or refine; avoid long questionnaires.
- **Single source of progress** — Treat the latest approved section as the source of truth for the next step.
- **Use the ask-user tool** — All decision points, approvals, and confirmations must use the ask-user tool. Do not ask open-ended questions in plain text when a structured choice is appropriate.

For **how to create each section and expected format**, see [reference.md](reference.md).
