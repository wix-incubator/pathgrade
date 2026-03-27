# Product Strategy — Section Guides & Expected Format

When drafting each section, follow the **Method**, **Guidelines**, **Structure**, and **Output requirements** below for that section. See [SKILL.md](SKILL.md) for the workflow order.

---

## Target Audience — How to Define

### Purpose

Define who this product primarily serves and how other user types are affected, before moving to problem and intent definition.

### Method

- Determine whether the audience should be defined using:
  - **Wix user taxonomy**, and/or
  - **A custom segment** (e.g., geography, plan tier, behavior, industry)
- Identify a **single Primary User:** the group most directly served by the product
- Identify **relevant Secondary Users:** users indirectly affected by the product
- Prefer **role-based and context-based** definitions over personas
- **Use `kb-retrieval` to enrich:** Query `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval kb-retrieval__retrieve_relevant_documents_from_kb` with the product domain to surface known audience definitions, segment characteristics, or domain-specific user context. If the project brief has Domain References with KB IDs, use those directly instead of re-navigating. Research leads — kb-retrieval adds depth and validates, never overrides.
- **Assess business relevance:** For each user type, evaluate why this segment matters to Wix — not just that they have a pain point. Consider: segment size (how many?), revenue contribution or potential, growth trajectory, strategic alignment with Wix priorities. When data analysis or research summary artifacts exist, use actual numbers for sizing and revenue. When they don't, state the business rationale qualitatively and flag sizing as "TBD — pending data."

### Wix User Taxonomy Reference (Use Only If Relevant)

Use these categories only when they accurately represent the audience. If research suggests a different segmentation, define a custom segment instead.

| Category | Description |
|----------|-------------|
| **Self-Creator** | Builds and manages their own Wix site or business |
| **Partner** | Agency or freelancer managing sites for clients |
| **UoU (User of User)** | End user of a Wix site (visitor, buyer) |
| **Developer** | Uses APIs, Velo, or MCP to build logic |
| **Studio User** | Professional using Wix Studio for advanced sites |

### Guidelines

- Clearly distinguish Primary and Secondary users
- Describe users by role, context, and responsibility
- Focus on impact and need, not solution
- Avoid listing features, tools, or UI
- Keep descriptions short and concrete
- Include why each audience segment is meaningful to Wix (business impact, not just intent fit)

### Structure

Format: Structured bullets per user type.

**Primary User**

- **User Type:** \<role / audience\>
- **User Impact:** \<how this product affects their work or outcome\>
- **Business Impact:** \<expected effect on Wix business — e.g., revenue growth, retention, competitive positioning, market expansion. Quantified when data exists, qualitative otherwise\>

**Secondary Users** (Repeat per User Type)

- **User Type:** \<role / audience\>
- **User Impact:** \<how this product affects them\>
- **Business Impact:** \<expected effect on Wix business\>

---

## Problem Statement — How to Define

### Purpose

Define the core user and business problem the product addresses, based on the validated Primary User, before moving to intents and solutions.

### Method

- Anchor the problem to the **Primary User** defined in the previous step
- Use the **5 Whys** method to drill from the observable symptom to the true root cause:
  1. Start with the observable problem (what users complain about or struggle with)
  2. Ask "Why does this happen?" — identify the first-level cause
  3. Ask "Why?" again on that cause — go one level deeper
  4. Repeat up to 5 times until you reach a cause that is actionable and specific
  5. Stop when the answer reveals something the product can actually address
  - **Show the chain to the user** so they can validate or correct it before finalizing
  - Example: *Users abandon checkout → Why? They hit an unexpected shipping cost → Why? Cost isn't shown until the last step → Why? The flow was designed to minimize upfront friction → Root cause: transparency was deprioritized in the original design*
- Separate clearly between:
  - The **observable problem** (what is wrong), and
  - The **underlying cause** (why it is happening)
- Frame the problem from a **user-centered perspective**, without implying solutions

### Guidelines

- Describe the current limitation, failure, or friction
- Explain both user and business impact
- Avoid implementation or solution language
- Avoid feature requests or design ideas
- Focus on symptoms first, then causes
- Keep the total section concise (usually three short paragraphs)

### Structure

Format: Three short paragraphs, preceded by the 5 Whys reasoning chain.

**5 Whys Chain** *(show to user for validation before finalizing)*

\<Observable problem\> → Why? \<Cause 1\> → Why? \<Cause 2\> → … → Root cause: \<actionable underlying cause\>

**Problem**

\<1 short paragraph describing the current limitation and its user / business impact\>

**Root Cause**

\<1 short paragraph explaining the validated underlying cause from the 5 Whys\>

**Opportunity**

\<1 short paragraph describing what becomes possible once the root cause is solved\>

### Output Requirements

- Clearly differentiate between **the problem** (what is wrong) and **the root cause** (why it is happening)
- Include the 5 Whys chain so the user can validate before the section is finalized
- Must not imply or hint at specific solutions

---

## Intents & Feelings — How to Define

### Purpose

Define what the user is trying to achieve and how they expect to feel when successful, in order to guide product, UX, and quality decisions.

### Method

- Identify the **Main Intent:** the core user goal that must be achieved for the product to succeed
- Extract relevant **Sub-Intents:** secondary or supporting goals that contribute to the main intent
- Clarify **emotional outcomes:** how users feel today; how they expect to feel when intents are fulfilled
- Validate that all intents are: user-centered, evidence-based, free of solution bias
- Prioritize each intent as: **Blocker** | **Critical** | **Nice to Have** | **Out of Scope**

### Guidelines

- Write intents in first person: *"I want to … so that …"*
- **Number every intent** with format `#int-001`, `#int-002`, etc. Numbering **restarts from 001 for each user type** (Primary User: #int-001, #int-002, …; next user type: #int-001, #int-002, …). Use these IDs so you can refer to a specific intent when iterating (e.g. "update #int-003").
- Focus on goals and outcomes, not solutions
- Separate Main Intent and Sub-Intents only when meaningful
- Avoid feature, UI, or technical language
- Include emotional states to guide UX and quality decisions
- Ensure each intent reflects real user evidence

### Structure

Format: Structured blocks per user type. Each intent has an **ID** (`#int-001`, etc.); numbering restarts for each user type.

**Primary User**

**Main Intent**

- **ID:** #int-001
- **Intent:** I want to … so that …
- **Priority:** \<Blocker | Critical | Nice to Have | Out of Scope\>
- **Current Feelings:** \<comma-separated\>
- **Expected Feelings:** \<comma-separated\>

**Sub-Intents** (Optional — repeat per Sub-Intent; continue numbering: #int-002, #int-003, …)

- **ID:** #int-002
- **Intent:** I want to … so that …
- **Priority:** \<Blocker | Critical | Nice to Have | Out of Scope\>
- **Current Feelings:** \<comma-separated\>
- **Expected Feelings:** \<comma-separated\>

**Secondary Users** (Repeat per User Type; **restart numbering at #int-001** for each user type)

**Main Intent**

- **ID:** #int-001
- **Intent:** I want to … so that …
- **Priority:** \<Blocker | Critical | Nice to Have | Out of Scope\>
- **Current Feelings:** \<comma-separated\>
- **Expected Feelings:** \<comma-separated\>

### Output Requirements

- Every intent must have a unique **ID** (`#int-001`, etc.) within its user type; numbering restarts for each user type so you can refer to intents when iterating (e.g. "change #int-002").
- Each Primary User must have one clear Main Intent
- Sub-Intents must support (not replace) the Main Intent
- All intents must be traceable to research
- Priorities must reflect actual product risk and value
- Emotional states must be realistic and evidence-based
- No intent may imply a specific implementation

---

## Solution Statement — How to Define

### Purpose

Evaluate solution directions across key dimensions and make an informed decision on the direction that best solves the user problem within real constraints. The output is a single statement — but the process is a structured evaluation, not a guess.

### Method

**1. Gather inputs across dimensions**

Before generating options, collect what is known. Each dimension has a defined source and fallback:

| Dimension | Source | If missing |
|-----------|--------|------------|
| **User problem fit** | Derived from approved Problem Statement + Intents | Always available — never a gap |
| **Current state & integration** | Current state research file | Ask one focused question; if still unknown → state assumption and flag |
| **Competitive positioning** | Competitor research file | Use if exists; if not → note as "not validated" and proceed |
| **Reusability / cross-Wix** | Internal research file | Ask one focused question; if still unknown → note as TBD |
| **Scope / time horizon** | Derived from direction evaluation | Surfaces as a tradeoff in each direction — never pre-ask |

**2. Generate 2–3 solution directions**

Based on gathered inputs, generate 2–3 distinct directions that naturally span different strategic approaches. Each direction should embody a different stance — for example: a quick patch, a full native solution, or leveraging an existing Wix product. Do not ask the creator to pre-select a scope; let the directions themselves surface the options. Each direction should:
- Directly address the root cause from the Problem Statement
- Be described in plain language — no features, no UI, no technical detail

**3. Evaluate each direction**

For each direction, evaluate against the dimensions:
- Does it solve the root user problem?
- How does it integrate with the current product state?
- Does it create a competitive advantage, match parity, or close a gap?
- Is there reuse potential — from other Wix products, or for others to reuse what we build?
- What scope does this require — quick patch, phased, or full solution?
- What are the key tradeoffs?

Surface tradeoffs explicitly — e.g. "faster but shallower" or "stronger but requires more investment."

**4. Recommend and let the creator decide**

- Present the evaluation
- Recommend one direction with a brief rationale
- Ask the creator to confirm or choose differently:
  - \<Direction A — short label\>
  - \<Direction B — short label\>
  - \<Direction C — short label\> *(if applicable)*

**5. Crystallize into one sentence**

Once the creator chooses, write the Solution Statement as one concise sentence.

### Guidelines

- One concise sentence in the final output
- Direction only — no features, UI, or technical detail
- Grounded in approved Problem Statement, Target Audience, and Intents
- Reflect the chosen scope (patch / full / phased)

### Structure

**Solution Direction**

\<One concise sentence describing the chosen solution direction and its value\>

**Assumptions & open questions** *(only if any dimension was missing or assumed)*

- \<Assumption or open question #1\>
- \<Assumption or open question #2\>

---

## Product Solution Summary — How to Define

### Purpose

Crystallize the product solution into a concrete, plain-language summary that bridges the abstract Solution Statement with a detailed spec. This is the "here's what we're actually building" checkpoint — it should be clear enough that anyone reading it understands what ships.

### Method

- Derive from all approved sections (Target Audience, Problem Statement, Intents, Solution Direction) plus any research or current-implementation context available
- Focus on concrete capabilities, not abstract direction
- Assess feasibility based on known technical context (APIs, data, existing infrastructure)
- Split scope into what ships in V1 vs. what comes later

### Guidelines

- Plain language — no jargon, no feature-spec formatting
- Capabilities as bullets, not user stories or FRs
- Feasibility assessment should reference specific evidence (e.g., "data already exists via X API")
- V1 vs. later split should reflect real prioritization, not wishful thinking
- Keep it concise — this is a summary, not a spec

### Structure

**What we're building**

\<1–2 sentence plain-language description of the product solution\>

**What it does**

- \<Capability 1\>
- \<Capability 2\>
- \<Capability 3\>
- *(3–5 bullets describing actual capabilities)*

**Why it's feasible**

\<1–2 sentences on technical readiness — what already exists, what's straightforward\>

**V1 vs. later**

- **V1:** \<comma-separated list of must-haves\>
- **Later:** \<comma-separated list of differentiators or follow-ups\>

### Output Requirements

- Must be concrete enough that a non-technical stakeholder understands what ships
- Capabilities must trace back to approved Intents
- Feasibility must reference evidence, not assumptions
- V1 scope must be realistic — not everything from the intents list

---

## Why Now & Impact — How to Define

### Purpose

Explain why solving this problem is urgent now, using evidence and alignment with Wix strategy. Check that the feature impact is aligned with Wix annual plan or company gameplan.

### Method

- **Search for strategy documents first:** Check the project brief for a `## Domain Gameplan` link. Also scan the workspace for `annual-plan.md`. Use these to validate alignment when drafting the Why Now statement.
- **If documents are not found:** Tell the user that no annual plan or domain gameplan was found. Ask how to proceed: does the user want to **add** these documents (path or link), or **proceed without** them? Do not draft the Why Now statement until the user has chosen (or has added the documents).
- **Use `kb-retrieval` for additional context:** Query `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval kb-retrieval__retrieve_relevant_documents_from_kb` with the product domain to surface strategic context, known business goals, or timing signals from the Wix knowledge base. Research and strategy documents lead — kb-retrieval adds supporting context only.
- **Use data artifacts when available:** When `data-analysis-*.md` or `research-summary-*.md` exist in discovery, extract quantified evidence — population sizes, conversion rates, revenue impact, trend data — and weave them into the Why Now and Business Impact statements. Cite specific numbers rather than vague claims.
- Base the rationale on validated inputs only:
  - Validated user pain or data trend (quantified from data analysis when available)
  - Alignment with Wix gameplan or annual plan (when available)
  - Competitive, retention, or strategic timing factors
  - Context from `kb-retrieval` (supporting, not primary)
- Ensure every statement is grounded in research or known business context
- Eliminate speculation or inflated claims

### Guidelines

- 1–2 sentences only
- Must explain urgency and expected impact
- Must reference strategic alignment
- No unsupported assumptions

### Structure

**Why Now**

\<1–2 sentences explaining why this problem is urgent now, referencing a specific user signal, business trend, or strategic moment\>

**Business Impact**

\<1–2 sentences describing the expected business outcome if this is solved — tied to Wix goals or gameplan when available. When data analysis provides baselines (e.g., current conversion rate, segment size, revenue figures), reference them to ground the impact claim.\>

---

## KPIs — How to Define

### Purpose

Define measurable indicators that show whether the product delivers real impact to Wix and to users, aligned with company goals.

### Method

- Derive KPIs from: the validated problem, main user intents, solution direction, Wix gameplan and annual plan
- Use comparable KPIs from: related products, similar business contexts
- **Use `kb-retrieval` for additional context:** Query `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval kb-retrieval__retrieve_relevant_documents_from_kb` with the product domain to surface known KPIs, benchmark metrics, or standard measurements used for similar features in the Wix knowledge base. If the project brief has Domain References with KB IDs, use those directly. Research and approved strategy sections lead — kb-retrieval adds supporting context only.
- **Cross-reference with data artifacts:** When `data-analysis-*.md` exists, check whether each proposed KPI has a measurable baseline. Include the current baseline value next to the KPI when available (e.g., "↑ Premium conversion rate (current: 3.2%, 30d)"). When a KPI has no baseline, note "baseline TBD — requires instrumentation."
- Define KPIs across relevant categories: **Wix Impact**, **User Impact**, **Monitoring**
- Consider risks and trade-offs: cannibalization, negative impact on existing products

### KPI Categories

Select only categories that are relevant to the feature.

**1. Wix Impact KPIs** — Direct business and strategic impact

Examples: ↑ Premium upgrades, ↑ Revenue / ARPU, ↑ Retention, ↓ Churn, ↑ Market penetration

**2. User Impact KPIs** — User success and outcomes

Examples: ↑ GPV per Self-Creator, ↑ % of active merchants, ↓ Time to complete key flows, ↑ Task completion rate

**3. Monitoring KPIs** — Experience, quality, adoption post-launch

Examples: ↑ Feature adoption, ↓ Error rate, ↑ Happy-flow completion, ↑ Session success rate, ↑ PREX score

### Guidelines

- Each KPI must be measurable and specific
- Define clear direction (↑ / ↓, timeframe)
- Align with company-level goals
- Tie KPIs to intents and opportunities
- Reject vague statements ("improve experience")
- **Never use NPS**
- Avoid vanity metrics
- Prefer actionable metrics

### Structure

Format: Up to three lists — include only categories relevant to the feature.

**Wix Impact KPIs** *(business and strategic impact)*

- \<KPI with direction ↑/↓ and timeframe\> *(baseline: X if known)*
- \<KPI with direction ↑/↓ and timeframe\> *(baseline: X if known)*

**User Impact KPIs** *(user success and outcomes)*

- \<KPI with direction ↑/↓ and timeframe\> *(baseline: X if known)*
- \<KPI with direction ↑/↓ and timeframe\> *(baseline: X if known)*

**Monitoring KPIs** *(experience, quality, adoption — include if relevant)*

- \<KPI with direction ↑/↓\>
- \<KPI with direction ↑/↓\>

### Output Requirements

- Minimum 2 KPIs per included category
- Every KPI must be traceable to a user intent or business goal from previous sections
- All KPIs must have a clear direction (↑ / ↓) and be measurable
- Include baseline values from data artifacts when available; mark as "baseline TBD" otherwise
- **Never use NPS**
- Omit Monitoring KPIs if not relevant to the feature scope
- After drafting, KPIs get a light sanity check: are they measurable, clearly directional, and non-overlapping? (This is not a full metric query review — just ensuring the KPIs are well-defined at a product level.)
