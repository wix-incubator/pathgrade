---
name: ck-new
description: Entry point for any creation work. Runs a lightweight conversational intake to capture what's already known, then produces a brief markdown document. Use when anyone says "new project," "start a feature," "project brief," "I have an idea," or when a creator is beginning any kind of product work.
disable-model-invocation: true
metadata:
  phase: initiation
  outputs: artifacts/project-brief-{project-name}.md
---

<!-- ck:ext-loading -->
Run `node ~/.agents/skills/ck-shared/scripts/load-ext.js ck-new` before executing any workflow step. If it outputs content, apply it as additional guidance (additive, not replacement). If no output, proceed normally.
<!-- /ck:ext-loading -->

# ck-new — Project Brief

Fast conversational intake to capture initial context. Produces a structured Project Brief that all downstream CreatorKit skills (research, competitor analysis, UX concepts, product strategy) use as their starting point.

**The whole experience should feel like under 3 minutes.**

> This skill is for anyone — PMs, designers, developers, or other guild members. Don't assume a specific role.

---

## Ground Rules

These apply throughout the entire intake:

- **One step per turn.** Each question gets its own message. After asking, stop and wait for the user's response. Never combine an acknowledgment or confirmation with the next question.
- **Don't paraphrase what the creator just said.** A brief reaction is fine ("Nice, print view for clinics") but don't echo their words back as a summary. They just said it — move to the next thing.
- **"Don't know" = TBD.** If the creator doesn't have an answer for any topic, write TBD and move on. Don't push.
- **Fast-track obvious sections.** If a topic is already clear from context or earlier answers, confirm briefly and move on — don't ask the full question.
- **Don't re-ask what you already have.** If one answer covers multiple topics, skip the ones already answered.
- **Don't ask research questions.** Things like "how are users working around this today?" belong in the research phase, not here. Only ask about what the creator already knows.
- **Use the creator's language.** Don't add emotional framing, editorialize pain points, or rephrase their words with stronger sentiment. Stick to what they actually said.
- **Structured questions are for choices, not for everything.** Use structured questions when offering structured options (yes/no, pick from a list). For open-ended questions where the creator needs to reflect and express themselves, use plain text. Don't overuse it — it gets annoying.
- **No `<summary>` section.** This skill is fast enough that a summary at the end of each response adds clutter. Skip it.

---

## MCP Auth Preflight (silent)

For `mcp-s`-backed MCPs in this skill, follow `~/.agents/skills/ck-shared/references/mcp-s-cli-docs.md`.

If Jira still needs its own sign-in, pause and let the creator complete that one-time Jira auth before retrying. If Jira still isn't available, fall back to asking the creator to paste the ticket content.

---

## Opening

Start with a short one-liner explaining what this is, followed by the opening question. No structured question, just text:

> "Let's put together a quick project brief — it'll be the starting point for everything you do next (user voice, competitor analysis, data, product strategy, UX concepts etc.).
>
> Tell me what you're working on — could be a new feature, a problem you're investigating, a decision you need to make, or just an idea you're exploring. If you have a Jira ticket, doc, or screenshot, feel free to drop that in too."

After the creator responds:
1. Extract whatever maps to the 4 topics (Context, Direction, Goal, Target Group)
2. Silently infer their **mode** (creating something, investigating, deciding, exploring, quick concept) — use this to shape how you phrase follow-up questions, but never show or mention the mode to the creator
3. Only follow up on what's genuinely missing

**Handling shared material:**
- **Pasted text or uploaded file:** read and extract directly
- **Jira URLs or ticket keys:** after the MCP auth preflight passes, fetch the ticket with `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s`. Extract the issue key from the URL (e.g. `PROJ-123` from `https://wix.atlassian.net/browse/PROJ-123`), derive the project key (`PROJ`), then run:

```bash
npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s jira jira__get-issues '{"projectKey":"PROJ","jql":"key = PROJ-123","fields":["summary","description","status","issuetype","priority"],"maxResults":1}'
```

If the fetch fails or Jira auth is still missing, fall back to asking the creator to paste the content.
- **Other auth-gated URLs:** ask the creator to paste the content or share a screenshot.
- **Screenshots or images:** describe what you see, extract what you can, and confirm your reading with the creator before using it
- If material covers multiple topics, acknowledge what you pulled ("Got context from your ticket — just need a couple more things") and skip to whatever's still missing
- Anything that doesn't fit the 4 topics → capture in a `## More` section

**Material arriving mid-conversation:** If the creator shares a doc, screenshot, or link at any point during the intake (not just at the start), absorb it the same way — extract what's relevant, update your understanding, and continue from where you are. Don't restart the flow.

---

## Conversational Intake

The brief covers 4 topics: Context, Direction, Goal, Target Group. Skip any already answered by the opening or provided material. Adapt phrasing based on the inferred mode.

### 1. Context

Captures the product domain and what prompted this work. Almost always, the domain is obvious from what the creator described — infer it and confirm in plain text: *"Sounds like this lives in [Domain] — right?"* No need for a structured question here.

Only ask *"What product area does this live in?"* if the domain is genuinely unclear from everything shared so far.

If they name a feature instead of a domain, infer the domain and confirm the same way.

The trigger (what sparked this) is not asked separately — extract it from the opening response or provided material. If it doesn't come up naturally, that's fine.

---

### 2. Direction

If the creator already described what they want to build or how they see this working, that IS the direction — confirm it in one sentence and move to the next topic. Don't ask a follow-up question about it.

Only ask if direction is genuinely missing: *"What's your take on this so far? It's totally fine if you don't have a clear answer."*

If no answer, mark TBD and move on.

---

### 3. Goal

Use the ask-user tool. Ask the user (allow multiple selections):
> "What are you trying to achieve?"

Use a structured question tool. Options: **Solve a user pain point** / **Grow a metric** / **Close a competitive gap** / **Validate an idea** / **Respond to a request** / **Not sure yet**

---

### 4. Target Group *(optional)*

Infer the most likely target group from context, then ask the user (allow multiple selections) to let the creator confirm or adjust:
Use the ask-user tool.
> "Sounds like this is for [inferred group] — adjust if needed."

Use a structured question tool. Options: **Self-Creator** / **Partner (agency/freelancer)** / **Developer** / **Studio User** / **Not sure yet**

*(Self-Creator = Wix user managing their own site; Partner = building for others)*

If not sure → TBD, move on.

---

## KB Enrichment (silent)

After collecting all intake answers, silently query the KB to enrich your understanding of the creator's domain. Don't announce this step or mention KB results to the creator — just weave the context into the brief you'll generate later.

Before starting KB enrichment, make sure the MCP auth preflight above has already passed.

**Navigator KB id:** `10333242-6161-475f-a6b9-1156eda72886`

1. Use `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s` to query the Navigator KB:

```bash
npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval kb-retrieval__retrieve_relevant_documents_from_kb '{"knowledge_base_id":"10333242-6161-475f-a6b9-1156eda72886","query":"<product area + problem/feature keywords>","limit":5}'
```

2. Parse each result's `content` as JSON. Read the `kb_id` field.
   - Use the first (highest-ranked) result whose `kb_id` is a UUID → make one additional call to that domain KB for business goals, audience segments, strategic priorities, known pain points.
   - If no result has a UUID `kb_id` → use only the `description` fields from the Navigator results. Do not make a second call.
3. Record each relevant domain's name and KB ID for the brief's Domain References section. Downstream skills (data, research, product) use these IDs to query domain knowledge without re-navigating.
4. Also look for a `gameplan_link` field in each Navigator result's content. If found, record it for the brief's Domain Gameplan section.

**Maximum calls: 2** (Navigator lookup + one domain KB lookup). Never chain more than one domain KB call.

**What to use for the brief prose:** Business goals, audience segments, strategic priorities, known pain points. Use these to:
- Write a more grounded **Context** section in the brief
- Validate or refine the **Target Group** if the KB data suggests a different or more specific audience
- Add relevant domain context to the **More** section if it goes beyond what the creator shared

### KB Connection Prompt

If the KB call fails, say:

> "I can enrich the brief with domain context from the knowledge base, but the KB MCP isn't reachable right now.
>
> You can paste a strategy or gameplan doc directly, or just say 'skip' to continue without it."

Then wait for the user's response:
- **Pastes a doc** → use it as domain context in place of KB enrichment; skip Domain Gameplan Link
- **Skip** → skip enrichment and Domain Gameplan Link entirely

---

## Domain Gameplan Link

**Only run this step if KB enrichment ran successfully and did not find a `gameplan_link`.** Skip if KB was unavailable, skipped, or already returned a gameplan link.

Use the ask-user tool. Ask the user:
> "Do you have a link to the domain gameplan or strategy doc? This helps align the product strategy later."

Use a structured question tool. Options: **Yes, I'll share it** / **Skip for now**

- If yes → ask the creator to paste the URL, then include it in the brief's `## Domain Gameplan` section.
- If skip → omit the section from the brief.

---

## Resolve Project Directory

The project directory is the current working directory (CWD) — wherever the creator opened their editor or terminal. CreatorKit does not assume any particular repository structure.

### Rules

1. **CWD is the project directory.** Don't search for a monorepo root, don't look for a `projects/` folder, don't try to infer a "correct" location from the product domain.
2. **If the creator explicitly names a different directory** in the conversation (e.g. "save it in ~/work/my-feature"), use that instead.
3. **Never relocate outputs based on product area.** If the creator is in `~/projects/logo-maker/` and describes a calendar feature, the outputs still go under `~/projects/logo-maker/` — that's where they chose to work.
4. Resolve silently — don't narrate the discovery process.

### Derive project name

Use the project name you inferred for the brief. Slugify it to lowercase-kebab-case (e.g. "Gift Card" → `gift-card`).

All subsequent paths (`artifacts/`, `context/`, the brief) are relative to CWD.

---

## Set Up Project Folders

Silently create the following folders under CWD. Do not interrupt the conversation — just do it.

- `artifacts/` — where skill outputs are saved
- `context/` — where the creator can place reference files used by downstream skills

---

## Generate the Brief

Before writing, do a quick internal consistency check:
- Does the target group make sense for the context?
- Does the direction align with the context?
- If something feels off, flag it briefly before generating.

Generate the output to `artifacts/project-brief-{project-name}.md`, creating the directory if it does not exist.

### Output Format

```markdown
# Project Brief: [Inferred Project Name]

> Pre-Research Stage — Everything here reflects initial assumptions and early analysis. Nothing has been validated yet.

## Context
[Product domain and what prompted this work]

## Direction
[Early direction — or TBD]

## Goal
[What the creator is trying to achieve — or TBD]

## Target Group
[User type(s) — or TBD]

## More *(if needed)*
[Anything the creator shared that doesn't fit above]

## Domain References *(auto-generated from KB enrichment)*
[Omit this section entirely if KB enrichment was unavailable.]

| Domain | KB ID |
|--------|-------|
| [Domain name] | [kb_id UUID] |

## Domain Gameplan
[Omit this section entirely if no gameplan link was found (neither from KB nor from the creator).]

[Link to domain gameplan / strategy document]
```

Rules for the brief:
- **Refine, don't repeat.** Take the creator's input and make it clearer, more coherent, and more product-oriented — but keep their intent and framing intact. Don't parrot back raw answers; write something they'd be proud to share.
- Use plain language — no jargon unless the creator used it first.
- Where uncertain or skipped → write `TBD / Not yet defined`. Never fabricate.
- A brief with 3 TBDs is still a useful brief.

---

## Final Approval & Next Steps

After saving the brief, mention the `artifacts/` folder so the creator knows where all future outputs will live. Frame it as context, not an action they need to take.

Combine this with the approval check and a next step suggestion in a single message. Suggest the most valuable next step based on the inferred mode:

| Mode | Suggested next step |
|------|-------------------|
| Creating (new feature) | Discovery flow — user voice, competitor analysis, product strategy, then UX concepts |
| Investigating (problem) | User voice analysis or data/metrics to understand the problem |
| Deciding | Data/metrics to inform the decision |
| Quick concept | UX concepts to quickly visualize the idea |
| Exploring | Competitor research to see how others approach it |

Only suggest UX concepts directly if the creator explicitly said they want to check or visualize a concept. Otherwise, research and product strategy come before UX.

Frame it naturally as a single suggestion, not a menu. For example: *"Brief is saved at `artifacts/project-brief-print-calendar.md`. All skills will save their outputs here under `artifacts/`. Since you're trying to solve a user pain point, a good next step would be the discovery flow — pull in user voice data to understand the specific pain points and use cases, then check how competitors handle print/export. That'll give you a solid foundation before jumping into UX concepts. Anything you'd change in the brief before moving on?"*

If edits needed, update the file and re-confirm.

---

## Repository references (optional)

After confirming the brief is saved, offer to link GitHub repositories to this project — no pressure if they don't have any in mind yet.

Use the ask-user tool. Ask the user:
> "One last thing — do you have any GitHub repos related to this feature? If so, I can add them as references so downstream skills can read the code directly. Totally fine to skip this for now."

Use a structured question tool. Options: **Yes, I have repos to add** / **Skip for now**

**If yes:**
Ask the user to share the URL(s) — one or more, one per line or comma-separated. Both HTTPS and SSH formats work.

For each URL provided, follow the `ck-utility-references` skill (`~/.agents/skills/ck-utility-references/SKILL.md`) to add the reference.
**Target directory:** use CWD (where the brief was just saved) — skip the directory discovery step in `~/.agents/skills/ck-utility-references/SKILL.md`.

After adding, let the user know which repos were linked.

**If skip:** wrap up naturally — no nudge to come back to it.

---

## Open Feature Branch

After the brief is finalized and references are handled, create a feature branch so that any subsequent work doesn't land on master by accident.

1. Check the current branch: `git branch --show-current`
2. **If already on a feature branch** (not `master`, `main`, or `prod`) → skip this step silently.
3. **If on `master`/`main`/`prod`:**
   - Derive the branch name from the project name: `git checkout -b {project-name}` (use the same slugified name from the brief, e.g. `gift-card`).
   - Tell the creator: *"Switched to branch `{branch-name}` so your work stays off master."*

---

## Principles

- **Converse, don't interrogate.** This should feel like reasoning out loud with a colleague.
- **Fast over complete.** TBD is fine. Don't block on missing info.
- **Absorb, don't restart.** New material mid-conversation gets folded in — don't go back to the beginning.
- **Brief is the deliverable.** Everything leads to a clean, usable brief that downstream skills will rely on.
