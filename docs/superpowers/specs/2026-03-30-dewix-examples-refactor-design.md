# De-Wix Examples Refactor Design

> Refactor `ck-new` and `ck-product-strategy` examples to be platform-agnostic for public npm publication.

## Motivation

Pathgrade is being published to the public npm registry. The `ck-new` and `ck-product-strategy` examples contain deep Wix-specific references (internal MCP tools, KB IDs, user taxonomy, annual plans, Jira integration) that are inappropriate for a platform-agnostic open-source package. These examples must be refactored to use a fictional eCommerce platform ("Acme Commerce") while preserving identical eval structure, grader logic, and pathgrade feature coverage.

## Approach

Direct find-and-replace with a systematic mapping table. Keep identical file structure, task count, grader logic, and conversation patterns. Every Wix concept gets a 1:1 equivalent.

---

## Naming & Directory Structure

| Current | New |
|---------|-----|
| `examples/ck-new/` | `examples/project-intake/` |
| `examples/ck-product-strategy/` | `examples/product-strategy/` |
| `ck-new.eval.ts` | `project-intake.eval.ts` |
| `ck-product-strategy.eval.ts` | `product-strategy.eval.ts` |

Skill names in SKILL.md frontmatter: `ck-new` → `project-intake`, `ck-product-strategy` → `product-strategy`.

Task name changes:
- `tool-aware-fix` → unchanged (already generic)
- `scripted-gift-card` → `scripted-loyalty-program`
- `persona-gift-card` → `persona-loyalty-program`
- `scripted-smart-cart` → unchanged (generic eCommerce concept)
- `persona-smart-cart` → unchanged

---

## Domain & Company Mapping

**Fictional company: "Acme Commerce"** — a generic eCommerce platform that lets merchants build online stores.

### Platform Mapping

| Wix Concept | Acme Commerce Equivalent |
|-------------|--------------------------|
| Wix Stores | Acme Storefront |
| Wix Marketplace | Acme App Market |
| Rise.ai (gift cards/store credit) | Acme Loyalty (loyalty programs/store credit) |
| Wix Studio | Acme Pro |
| Velo (developer API) | Acme SDK |
| Domain Gameplan | Product Roadmap |
| Wix Vibe, Web5, etc. | Removed (no equivalent needed) |
| Wix Design System | Removed (not referenced in eval logic) |

### User Taxonomy Mapping

| Wix User Type | Acme Equivalent |
|---------------|-----------------|
| Self-Creator | Store Owner |
| Partner | Agency |
| Developer | Developer (unchanged) |
| Studio User | Power User |
| UoU (User of User) | Shopper |
| Not sure yet | Not sure yet (unchanged) |

### Competitor Mapping

| Real Company | Fictional Equivalent |
|-------------|---------------------|
| Shopify | ShopEasy |
| BigCommerce | CartCloud |
| Squarespace | SquareSite |
| WooCommerce | OpenCart Pro |
| Amazon | MegaMart |

### KB Domain Mapping

| Wix KB Domain | Acme KB Domain |
|---------------|----------------|
| Online Stores | Storefront |
| Rise.ai | Loyalty & Credits |
| Navigator KB | Platform Navigator |

---

## MCP & Knowledge Base Refactor

### `mcp-config.json`

Replace `@wix/internal-docs-mcp` with `acme-docs-mcp`. Remove Wix npm registry URL and `@wix/creator-kit` reference.

### `mcp-mock-kb.ts`

Same multi-layer structure, all IDs and content replaced:
- **Platform Navigator**: returns domains "Storefront", "Loyalty & Credits" with new UUIDs
- **Domain KBs**: Acme-flavored objects (business goals, value propositions, audience segments)
- Audience segments keep same structure: `small_medium_merchants`, `enterprise_merchants`, etc.

### SKILL.md MCP References

- Remove Jira/Wix Atlassian integration → generic "task tracker" MCP tool
- Remove `~/.agents/skills/ck-shared/` path references
- Remove `@wix/creator-kit` CLI references
- Keep KB enrichment workflow with generic MCP tool names

---

## SKILL.md Content Refactor

### `project-intake` SKILL.md

- Name: `project-intake`
- Downstream skills: `research`, `competitor-analysis`, `ux-concepts`, `product-strategy`
- User type options: Store Owner, Agency, Developer, Power User, Shopper, Not sure yet
- Product domain examples: "Acme Storefront", "Acme App Market"
- KB enrichment: keep workflow, use generic MCP tool names

### `product-strategy` SKILL.md

- Name: `product-strategy`
- Remove all `ck-` prefixed references
- Input/output artifact paths unchanged

### `product-strategy` reference.md

- User taxonomy: Acme equivalents
- KPI categories: "Wix Impact" → "Platform Impact", "Premium upgrades" → "Subscription upgrades", "GPV per Self-Creator" → "GMV per Store Owner"
- Remove "PREX" metric
- Domain Gameplan → Product Roadmap

### `product-strategy` annual-plan.md (two versions)

There are two `annual-plan.md` files with different content:

1. **`skill/annual-plan.md`** — full-length CEO-letter-style annual plan (~130 lines). Rewrite as "Acme Commerce 2026 Annual Plan" in the same narrative style, covering vision, strategic themes, eCommerce expansion, innovation projects — all fictional.

2. **`fixtures/annual-plan.md`** — condensed summary (~40 lines) with structured headers and bullet points. Rewrite as the abbreviated version of the same Acme Commerce plan: vision, prime directives (Growth, Speed), strategic themes, eCommerce goals (GMV +25%, AOV +15%, cart abandonment -5pp), company-wide metrics, innovation projects.

Both files must tell a consistent story about "Acme Commerce" but differ in length and format. Replace Shopify with ShopEasy. Remove all Wix-specific innovation projects (Wix Vibe, Web5, Harmony, Base44, Studio, Wixel, Builder).

---

## Conversation Tasks

### `project-intake` — `scripted-loyalty-program`

Opener: "I want to build a loyalty program feature for our Acme Storefront platform"

Reactions (same regex patterns, updated content):
- Fallback provides loyalty program context for Acme Storefront
- Target audience response: "Store Owner"
- Goal response: "Solve user pain point — merchants can't retain customers"

### `project-intake` — `persona-loyalty-program`

Persona: "Acme Commerce PM with 2 years on the Storefront platform, direct and concise"

Facts (8):
1. Feature for Acme Storefront platform
2. Target: Store Owners
3. Goal: Solve pain point — can't offer loyalty rewards, lose repeat customers
4. Direction: Points system, tiered rewards, email notifications, checkout redemption
5. No tech implementation details known
6. No GitHub repos available
7. No product roadmap link available
8. Project name: "loyalty-program" or similar

### `product-strategy` — both tasks

- All "Wix Stores" → "Acme Storefront"
- Competitive references: ShopEasy instead of Shopify
- Persona: "Acme Storefront PM (3 years exp)"
- All 17 persona facts remapped with Acme equivalents

### Fixtures

- `project-brief-smart-cart.md`: Wix → Acme, Self-Creator → Store Owner, new KB IDs
- `user-voice-smart-cart.md`: platform references updated, quantified data kept
- `competitor-analysis-smart-cart.md`: 5 fictional competitors

---

## Grader Impact

### Zero changes (4 graders)

| Grader | Reason |
|--------|--------|
| `check-fix.ts` | Checks `app.js` exists and `add(2,3) === 5` |
| `tool-usage-fix.ts` | Checks `read_file` + `edit_file` actions |
| `check-brief.ts` | Checks section headers (Context, Direction, Goal, Target Group) — unchanged |
| `check-strategy.ts` | Checks structural patterns (section headers, `#int-\d{3}`, `↑`/`↓`) — domain-independent |

### Minor text updates (3 graders)

| Grader | Change |
|--------|--------|
| `rubric-scripted.ts` | Update domain references in rubric text |
| `rubric-persona.ts` | Update skill name (`project-intake`) + domain refs |
| `rubric-strategy.ts` | Update domain references in rubric text |

No grader logic, scoring algorithms, or weight distributions change.

---

## Complete File Manifest

### `project-intake/` (~14 files)

| File | Change |
|------|--------|
| `project-intake.eval.ts` | Rename + edit (tasks, opener, persona, reactions) |
| `mcp-config.json` | Edit (remove Wix packages) |
| `mcp-mock-kb.ts` | Edit (all KB IDs, domains, content) |
| `skill/SKILL.md` | Edit (name, taxonomy, domains, remove Wix integrations) |
| `skill/.claude-plugin/plugin.json` | Edit (name field) |
| `skill/agents/openai.yaml` | Verify (likely no changes) |
| `graders/check-brief.ts` | No change |
| `graders/check-fix.ts` | No change |
| `graders/tool-usage-fix.ts` | No change |
| `graders/rubric-scripted.ts` | Minor edit (rubric text) |
| `graders/rubric-persona.ts` | Minor edit (rubric text) |
| `fixtures/app.js` | No change |
| `fixtures/solve-fix.sh` | No change |
| `README.md` | Edit (name/description) |

### `product-strategy/` (~13 files)

| File | Change |
|------|--------|
| `product-strategy.eval.ts` | Rename + edit (tasks, opener, persona, reactions) |
| `skill/SKILL.md` | Edit (name, remove ck- refs) |
| `skill/reference.md` | Edit (taxonomy, KPIs, roadmap) |
| `skill/annual-plan.md` | Rewrite (full-length Acme Commerce 2026 narrative) |
| `skill/.claude-plugin/plugin.json` | Edit (name field) |
| `skill/agents/openai.yaml` | Verify (likely no changes) |
| `graders/check-strategy.ts` | No change |
| `graders/rubric-strategy.ts` | Minor edit (rubric text) |
| `fixtures/annual-plan.md` | Rewrite (condensed summary version of Acme Commerce 2026) |
| `fixtures/artifacts/project-brief-smart-cart.md` | Edit (platform refs, KB IDs) |
| `fixtures/artifacts/discovery/user-voice-smart-cart.md` | Edit (platform refs) |
| `fixtures/artifacts/discovery/competitor-analysis-smart-cart.md` | Edit (fictional competitors) |
| `README.md` | Edit (name/description) |

### Outside examples

- `pathgrade.eval.ts` — check for example path references
- Root `README.md` — check for example references

### Totals

- ~30 files touched
- 0 new files created
- 0 files deleted (directories renamed)
