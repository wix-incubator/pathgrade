# Platform-Agnostic Example Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ck-new` and `ck-product-strategy` examples to remove all Wix references, using a fictional "Acme Commerce" eCommerce platform. Rename to `project-intake` and `product-strategy`.

**Architecture:** Direct find-and-replace refactor with a systematic mapping table. Same file structure, task count, grader logic, and conversation patterns. Every Wix concept gets a 1:1 fictional equivalent.

**Tech Stack:** TypeScript, Markdown, JSON, YAML — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-30-dewix-examples-refactor-design.md`

---

## Mapping Tables (Reference for All Tasks)

### Platform Mapping
| Wix | Acme |
|-----|------|
| Wix Stores | Acme Storefront |
| Wix Marketplace | Acme App Market |
| Rise.ai | Acme Loyalty |
| Wix Studio | Acme Pro |
| Velo | Acme SDK |
| Domain Gameplan | Product Roadmap |
| CreatorKit | (remove or use "downstream skills") |

### User Taxonomy
| Wix | Acme |
|-----|------|
| Self-Creator | Store Owner |
| Partner | Agency |
| Developer | Developer |
| Studio User | Power User |
| UoU | Shopper |

### Competitors
| Real | Fictional |
|------|-----------|
| Shopify | ShopEasy |
| BigCommerce | CartCloud |
| Squarespace | SquareSite |
| WooCommerce | OpenCart Pro |
| Amazon | MegaMart |

---

### Task 1: Rename `ck-new` directory to `project-intake`

**Files:**
- Rename: `examples/ck-new/` → `examples/project-intake/`
- Rename: `examples/project-intake/ck-new.eval.ts` → `examples/project-intake/project-intake.eval.ts`

- [ ] **Step 1: Rename the directory**

```bash
git mv examples/ck-new examples/project-intake
```

- [ ] **Step 2: Rename the eval file**

```bash
git mv examples/project-intake/ck-new.eval.ts examples/project-intake/project-intake.eval.ts
```

- [ ] **Step 3: Commit**

```bash
git add examples/
git commit -m "refactor: rename ck-new to project-intake"
```

---

### Task 2: Rename `ck-product-strategy` directory to `product-strategy`

**Files:**
- Rename: `examples/ck-product-strategy/` → `examples/product-strategy/`
- Rename: `examples/product-strategy/ck-product-strategy.eval.ts` → `examples/product-strategy/product-strategy.eval.ts`

- [ ] **Step 1: Rename the directory**

```bash
git mv examples/ck-product-strategy examples/product-strategy
```

- [ ] **Step 2: Rename the eval file**

```bash
git mv examples/product-strategy/ck-product-strategy.eval.ts examples/product-strategy/product-strategy.eval.ts
```

- [ ] **Step 3: Commit**

```bash
git add examples/
git commit -m "refactor: rename ck-product-strategy to product-strategy"
```

---

### Task 3: Update test files for new paths

**Files:**
- Rename: `tests/examples.ck-new.test.ts` → `tests/examples.project-intake.test.ts`
- Rename: `tests/examples.ck-product-strategy.test.ts` → `tests/examples.product-strategy.test.ts`
- Modify: `tests/config-ts-loading.test.ts:97`

- [ ] **Step 1: Rename test files**

```bash
git mv tests/examples.ck-new.test.ts tests/examples.project-intake.test.ts
git mv tests/examples.ck-product-strategy.test.ts tests/examples.product-strategy.test.ts
```

- [ ] **Step 2: Update `tests/examples.project-intake.test.ts`**

Replace the entire file content with:

```typescript
import { describe, it, expect } from 'vitest';
import config from '../examples/project-intake/project-intake.eval';

describe('examples/project-intake scripted-loyalty-program eval tuning', () => {
  it('packs the scripted confirmation reply with goal and target information Codex tends to need early', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-loyalty-program');
    const reactions = (scriptedTask as any)?.conversation?.reactions ?? [];
    const confirmReaction = reactions.find((r: any) => r.when?.includes('right\\?'));

    expect(confirmReaction?.reply).toContain('solve a user pain point');
    expect(confirmReaction?.reply).toContain('Store Owner');
  });

  it('includes a scripted reply that nudges Codex to write the brief after vague progress checks', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-loyalty-program');
    expect(scriptedTask?.type).toBe('conversation');

    const reactions = (scriptedTask as any)?.conversation?.reactions ?? [];
    expect(reactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reply: expect.stringContaining('write the brief'),
          when: expect.stringMatching(/so far/i),
        }),
      ]),
    );
  });

  it('uses a rubric that accepts flexible intake ordering as long as the brief is completed', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-loyalty-program');
    const rubric = scriptedTask?.graders.find((grader) => grader.type === 'llm_rubric')?.rubric;

    expect(rubric).toContain('flexible');
    expect(rubric).toContain('required topics');
    expect(rubric).not.toContain('check→direction→goal→target flow');
  });
});
```

- [ ] **Step 3: Update `tests/examples.product-strategy.test.ts`**

Replace the entire file content with:

```typescript
import { describe, it, expect } from 'vitest';
import config from '../examples/product-strategy/product-strategy.eval';

describe('examples/product-strategy eval tuning', () => {
  it('tells both conversation tasks where the final strategy file must be saved', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-smart-cart');
    const personaTask = config.tasks.find((task) => task.name === 'persona-smart-cart');

    expect((scriptedTask as any)?.conversation?.opener).toContain('artifacts/product/product-strategy-smart-cart.md');
    expect((personaTask as any)?.conversation?.opener).toContain('artifacts/product/product-strategy-smart-cart.md');
  });

  it('includes a scripted reply that nudges Codex to save the final strategy to the expected path', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-smart-cart');
    const reactions = (scriptedTask as any)?.conversation?.reactions ?? [];

    expect(reactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reply: expect.stringContaining('artifacts/product/product-strategy-smart-cart.md'),
          when: expect.stringMatching(/final|save|artifact|kpi|prd/i),
        }),
      ]),
    );
  });
});
```

- [ ] **Step 4: Update `tests/config-ts-loading.test.ts`**

At line 97, change:

```typescript
    const strategyConfig = await loadEvalConfig(path.join(repoDir, 'examples', 'ck-product-strategy'));
```

to:

```typescript
    const strategyConfig = await loadEvalConfig(path.join(repoDir, 'examples', 'product-strategy'));
```

- [ ] **Step 5: Run tests to verify**

```bash
cd /Users/nadavlac/projects/pathgrade && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "test: update test files for renamed examples"
```

---

### Task 4: Refactor `project-intake/project-intake.eval.ts`

**Files:**
- Modify: `examples/project-intake/project-intake.eval.ts`

- [ ] **Step 1: Replace the eval file content**

Replace the entire file with:

```typescript
import { defineEval } from '../../src/core/define-eval';
import { checkFix } from './graders/check-fix';
import { checkBrief } from './graders/check-brief';
import { toolUsageFix } from './graders/tool-usage-fix';
import { rubricScripted } from './graders/rubric-scripted';
import { rubricPersona } from './graders/rubric-persona';
import { kbRetrievalMock } from './mcp-mock-kb';

export default defineEval({
  skillPath: 'skill',

  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.6,
  },

  tasks: [
    {
      name: 'tool-aware-fix',
      type: 'instruction',
      instruction: 'Read app.js, find the bug in the add function, and fix it so add(2,3) returns 5.',
      agent: 'claude',
      workspace: [
        { dir: 'fixtures' },
      ],
      solution: 'solve-fix.sh',
      trials: 1,
      timeout: 120,
      graders: [
        checkFix,
        toolUsageFix,
      ],
    },

    {
      name: 'scripted-loyalty-program',
      type: 'conversation',
      mcp_config: './mcp-config.json',
      conversation: {
        opener: `I want to start a new project. I have an idea for a loyalty program feature.\n`,
        completion: { max_turns: 12, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        reactions: [
          {
            reply: "Yes, that's right. The goal is to solve a user pain point, and the target group is Store Owner.",
            when: "right\\?|correct\\?|confirm|sound right",
          },
          { when: 'goal|trying to achieve|what are you trying', reply: 'Solve user pain point' },
          { when: 'target|audience|who|Store Owner|adjust if needed', reply: 'Store Owner' },
          { when: 'knowledge base|KB.*MCP|enrich.*brief|paste.*doc.*skip', reply: 'Yes, enrich the brief with available knowledge base resources' },
          { when: 'gameplan|strategy doc|roadmap', reply: 'Skip for now' },
          {
            when: 'take on this so far|what.*so far|ready to write|write the brief|next step',
            reply: 'Looks good so far. Please write the brief now.',
          },
          { when: "look right|approve|feedback|changes|edit|you'd change|anything.*change|move on|before moving", reply: 'Looks good, no changes' },
          { when: 'github|repo|reference', reply: 'No, skip repos for now' },
          {
            when: '.*', once: true,
            reply: `It's for the Acme Storefront platform. Online store owners have been
requesting the ability to offer loyalty rewards and store credit that
customers can earn and redeem at checkout.\n`,
          },
        ],
      },
      graders: [
        checkBrief,
        rubricScripted,
      ],
    },

    {
      name: 'persona-loyalty-program',
      type: 'conversation',
      mcp_mock: kbRetrievalMock,
      conversation: {
        opener: `I want to start a new project. I have an idea for a feature\nrelated to loyalty programs for online stores.\n`,
        completion: { max_turns: 15, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        persona: {
          description: `You are a product manager at Acme Commerce who has worked on the Storefront\nplatform for 2 years. You communicate directly and concisely.\nWhen asked a multiple-choice question, pick the most appropriate\noption. When asked for confirmation, confirm if correct. You're\ncollaborative but don't volunteer extra information unless asked.\n`,
          facts: [
            'The feature is for the Acme Storefront platform',
            'Target users are Store Owners (merchants managing their own shops)',
            'Goal: solve user pain point — store owners can\'t offer loyalty rewards and lose repeat customers',
            'Direction: points system, tiered rewards, email notifications, checkout redemption',
            'You don\'t know technical implementation details',
            'No GitHub repos to link right now',
            'No product roadmap link available',
            'The project name should be \'loyalty-program\' or similar',
          ],
        },
      },
      graders: [
        checkBrief,
        rubricPersona,
      ],
    },
  ],
});
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/examples.project-intake.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add examples/project-intake/project-intake.eval.ts
git commit -m "refactor: de-wix project-intake eval config"
```

---

### Task 5: Refactor `project-intake/mcp-config.json`

**Files:**
- Modify: `examples/project-intake/mcp-config.json`

- [ ] **Step 1: Replace file content**

```json
{
  "mcpServers": {
    "internal-docs-mcp": {
      "command": "npx",
      "args": [
        "acme-docs-mcp"
      ]
    },
    "octocode": {
      "command": "npx",
      "args": [
        "octocode-mcp@latest"
      ]
    },
    "google-workspace": {
      "type": "http",
      "url": "https://mcp.acme-commerce.dev/google-workspace"
    },
    "docs-schema": {
      "type": "http",
      "url": "https://mcp.acme-commerce.dev/docs-schema"
    }
  }
}
```

Note: `WixInternalDocs` entry removed (redundant with `internal-docs-mcp` after refactor). Local path replaced with `npx`. `mcp-s.wewix.net` URLs replaced with fictional `mcp.acme-commerce.dev`.

- [ ] **Step 2: Commit**

```bash
git add examples/project-intake/mcp-config.json
git commit -m "refactor: de-wix project-intake mcp-config"
```

---

### Task 6: Refactor `project-intake/mcp-mock-kb.ts`

**Files:**
- Modify: `examples/project-intake/mcp-mock-kb.ts`

- [ ] **Step 1: Replace file content**

```typescript
import { mockMcpServer } from '../../src/core/mcp-mock';

const navigatorKbResponse = {
  documents: [
    {
      entry: {
        doc_id: 'Acme Loyalty',
        title: 'Acme Loyalty',
        content: JSON.stringify({
          description: 'Acme Loyalty is a loyalty and store credit solution that helps merchants boost sales and customer retention through points programs, store credit, and rewards. The module integrates natively with Acme Storefront and other eCommerce platforms.',
          game_plan_link: null,
          kb_id: 'b2904bc6-2db3-536d-c4e0-2267feb83c10',
          kb_name: 'domains-kb-acme-loyalty',
          ownership_tag: 'loyalty-data',
        }),
      },
      scores_info: { overall_match_score: 0.864 },
    },
    {
      entry: {
        doc_id: 'Storefront',
        title: 'Storefront',
        content: JSON.stringify({
          description: 'We provide merchants with the tools they need to offer the best shopping experience on their website, from an attractive storefront to an easy product management dashboard.',
          game_plan_link: 'https://docs.google.com/document/d/1example-storefront-roadmap/edit',
          kb_id: 'c3a15bf5-3ec4-647e-d5f1-3378gfc94d10',
          kb_name: 'domains-kb-storefront',
          ownership_tag: 'storefront-data',
        }),
      },
      scores_info: { overall_match_score: 0.862 },
    },
  ],
};

const loyaltyKbResponse = {
  documents: [
    {
      entry: {
        doc_id: '3',
        title: 'business_kb',
        content: JSON.stringify({
          version: '2025-07-16',
          kb_type: 'business',
          domain: 'acme-loyalty',
          objects_layer: [
            { name: 'increase_repeat_purchases', object_type: 'business_goal', description: 'Help every merchant build customer relationships to maximize lifetime value through engagement and rewards.', domain: 'acme-loyalty' },
            { name: 'unify_credit_management', object_type: 'business_goal', description: 'Provide a unified wallet solution for all merchant credit, rewards, refunds, and store credit.', domain: 'acme-loyalty' },
            { name: 'provide_actionable_ai_insights', object_type: 'value_proposition', description: 'Deliver analytics and AI-powered recommendations for segmentation, personalization, lifecycle campaigns.', domain: 'acme-loyalty' },
            { name: 'automate_loyalty_rewards', object_type: 'value_proposition', description: 'Enable fully automated, proactive loyalty rewards and credit flows with minimal merchant effort.', domain: 'acme-loyalty' },
            { name: 'unified_credit_wallet', object_type: 'value_proposition', description: 'Single system to unify store credit, loyalty points, refunds, cashback, and rewards across channels.', domain: 'acme-loyalty' },
            { name: 'small_medium_merchants', object_type: 'audience_segment', description: 'Ecommerce/retail businesses with $1-10M annual revenue, >1k monthly orders, limited ops/tech resources.', domain: 'acme-loyalty' },
            { name: 'enterprise_merchants', object_type: 'audience_segment', description: 'Large-scale brands or chains, complex ops, multi-location, need customizable omni-channel loyalty/payment.', domain: 'acme-loyalty' },
            { name: 'marketing_growth_user', object_type: 'audience_segment', description: 'Brand/product/ecom managers running campaigns to drive revenue, engagement, and retention.', domain: 'acme-loyalty' },
            { name: 'finance_compliance_user', object_type: 'audience_segment', description: 'CFO, accounting, or finance-focused users who care most about liability, reporting, and accuracy.', domain: 'acme-loyalty' },
            { name: 'support_storefront_user', object_type: 'audience_segment', description: 'Support/cashiers/frontline team handling issue resolution, credit issuance, and customer delight.', domain: 'acme-loyalty' },
          ],
        }),
      },
      scores_info: { overall_match_score: 0.891 },
    },
  ],
};

export const kbRetrievalMock = mockMcpServer({
  name: 'kb-retrieval',
  tools: [
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base. Use knowledge_base_id to target a specific domain KB, or use the Platform Navigator (20444353-7272-586g-b7ca-2267feb94d97) to discover domains.',
      inputSchema: {
      type: 'object',
      properties: {
          knowledge_base_id: { type: 'string', description: 'The knowledge base ID to query' },
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max documents to return' },
        },
        required: ['knowledge_base_id', 'query'],
      },
      when: '20444353-7272-586g-b7ca-2267feb94d97',
      response: navigatorKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      when: 'b2904bc6-2db3-536d-c4e0-2267feb83c10',
      response: loyaltyKbResponse,
    },
    {
      name: 'retrieve_relevant_documents_from_kb',
      description: 'Retrieve relevant documents from a knowledge base.',
      response: navigatorKbResponse,
    },
  ],
});
```

- [ ] **Step 2: Commit**

```bash
git add examples/project-intake/mcp-mock-kb.ts
git commit -m "refactor: de-wix project-intake mcp-mock-kb"
```

---

### Task 7: Refactor `project-intake/skill/SKILL.md`

**Files:**
- Modify: `examples/project-intake/skill/SKILL.md`

This is the largest single file. Key changes:
- Frontmatter `name: ck-new` → `name: project-intake`
- Remove the ext-loading block (lines 9-11, references `~/.agents/skills/ck-shared/`)
- Replace "CreatorKit" with "downstream skills" (lines 14, 103)
- Remove Jira/wix.atlassian.net integration (lines 34-50)
- Remove `@wix/creator-kit` and `npm.dev.wixpress.com` references (lines 46-49, 83-85)
- Replace KB Navigator ID with fictional one
- Replace user taxonomy: Self-Creator → Store Owner, Partner → Agency, Studio User → Power User (line 75-76)
- Replace `ck-utility-references` path (line 159)
- Replace "Domain Gameplan" → "Product Roadmap" throughout

- [ ] **Step 1: Replace file content**

Write the full de-Wixed SKILL.md. The file is long, so here are the critical replacements to make throughout:

1. Frontmatter: `name: project-intake`
2. Delete lines 9-11 (ext-loading block referencing `ck-shared`)
3. Line 12→ title: `# project-intake — Project Brief`
4. Line 14→ replace: "all downstream CreatorKit skills (research, competitor analysis, UX concepts, product strategy)" with "all downstream skills (research, competitor analysis, UX concepts, product strategy)"
5. Lines 34-36: Replace MCP auth preflight. Remove references to `mcp-s`, `~/.agents/skills/ck-shared/references/mcp-s-cli-docs.md`. Replace Jira auth paragraph with: "For MCP-backed tools in this skill, ensure the relevant MCP servers are configured and accessible."
6. Lines 46-50: Remove entire Jira block (`npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s jira...`). Replace with: "**Task tracker URLs or ticket keys:** If a project management tool is available via MCP, fetch the issue details. If unavailable, ask the creator to paste the content."
7. Line 75: Replace options: `**Store Owner** / **Agency** / **Developer** / **Power User** / **Not sure yet**`
8. Line 76: Replace parenthetical: `*(Store Owner = merchant managing their own store; Agency = building for others)*`
9. Lines 82-85: Replace Navigator KB id with `20444353-7272-586g-b7ca-2267feb94d97`. Replace `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s` with `the kb-retrieval MCP tool`
10. Line 103: Replace "CreatorKit does not assume any particular repository structure" with "This skill does not assume any particular repository structure"
11. Line 159: Remove reference to `ck-utility-references` skill (`~/.agents/skills/ck-utility-references/SKILL.md`). Replace paragraph with: "For each URL provided, add the repository reference to the project."
12. Replace all "Domain Gameplan" → "Product Roadmap" throughout

- [ ] **Step 2: Verify no Wix references remain**

```bash
grep -i "wix\|CreatorKit\|ck-new\|ck-shared\|wixpress\|wewix\|mcp-s\|creator-kit\|Self-Creator\|Studio User\|gameplan" examples/project-intake/skill/SKILL.md
```

Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add examples/project-intake/skill/SKILL.md
git commit -m "refactor: de-wix project-intake SKILL.md"
```

---

### Task 8: Refactor `project-intake` plugin metadata and graders

**Files:**
- Modify: `examples/project-intake/skill/.claude-plugin/plugin.json`
- Modify: `examples/project-intake/graders/rubric-scripted.ts`
- Modify: `examples/project-intake/graders/rubric-persona.ts`
- Verify: `examples/project-intake/skill/agents/openai.yaml` (no changes expected)

- [ ] **Step 1: Update plugin.json**

```json
{
  "name": "project-intake",
  "version": "1.0.0",
  "description": "Plugin-style metadata for the project-intake skill."
}
```

- [ ] **Step 2: Update rubric-scripted.ts**

```typescript
import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricScripted = llmRubricGrader({
    rubric: `Evaluate the multi-turn conversation for project-intake skill compliance.

Workflow (0-0.4):
- Did the agent ask questions one at a time (not multiple in one message)?
- Did the agent follow a flexible intake flow that still covered the required topics?
- Did it gather or reasonably infer the required topics (Context, Direction, Goal, Target Group)?
- Did it offer structured choices for Goal and Target Group when appropriate?

Brief Quality (0-0.4):
- Is the brief at artifacts/project-brief-*.md?
- Does it have all required sections (Context, Direction, Goal, Target Group)?
- Is content refined (not just echoing user replies)?
- Once enough information was available, did the agent move to writing the brief instead of stalling?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary back-and-forth)?
- Did the agent react naturally to user responses?`,
    weight: 0.5,
});
```

- [ ] **Step 3: Update rubric-persona.ts**

```typescript
import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricPersona = llmRubricGrader({
    rubric: `Evaluate the full persona-driven conversation.

Skill Discovery (0-0.2):
- Did the agent discover and use project-intake?

Conversation Flow (0-0.4):
- One question per turn?
- Adapted to user's communication style?
- Handled open-ended responses well?

Brief Quality (0-0.4):
- Complete brief with all sections?
- Content matches the facts the persona provided?
- Project name reasonable?`,
    weight: 0.5,
});
```

- [ ] **Step 4: Verify openai.yaml has no Wix refs**

```bash
cat examples/project-intake/skill/agents/openai.yaml
```

Expected: Only `policy: allow_implicit_invocation: false` — no changes needed.

- [ ] **Step 5: Commit**

```bash
git add examples/project-intake/skill/.claude-plugin/plugin.json examples/project-intake/graders/rubric-scripted.ts examples/project-intake/graders/rubric-persona.ts
git commit -m "refactor: de-wix project-intake plugin and graders"
```

---

### Task 9: Update `project-intake/README.md`

**Files:**
- Modify: `examples/project-intake/README.md`

- [ ] **Step 1: Replace file content**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add examples/project-intake/README.md
git commit -m "refactor: de-wix project-intake README"
```

---

### Task 10: Run tests for project-intake and verify

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/nadavlac/projects/pathgrade && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Grep for any remaining Wix references in project-intake**

```bash
grep -ri "wix\|CreatorKit\|ck-new\|ck-shared\|wixpress\|wewix\|mcp-s\|creator-kit\|Self-Creator\|Studio User\|Rise\.ai\|gameplan" examples/project-intake/
```

Expected: No output.

- [ ] **Step 3: Commit (if any fixes needed)**

If grep found residual references, fix them and commit with message: `fix: remove remaining Wix references from project-intake`

---

### Task 11: Refactor `product-strategy/product-strategy.eval.ts`

**Files:**
- Modify: `examples/product-strategy/product-strategy.eval.ts`

- [ ] **Step 1: Replace file content**

```typescript
import { defineEval } from '../../src/core/define-eval';
import { checkStrategy } from './graders/check-strategy';
import { rubricStrategy } from './graders/rubric-strategy';

const WORKSPACE = [{ dir: 'fixtures' }];

export default defineEval({
  skillPath: 'skill',

  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 1800,
    threshold: 0.6,
  },

  tasks: [
    {
      name: 'scripted-smart-cart',
      type: 'conversation',
      conversation: {
        opener:
          'I want to work on product strategy for our smart cart feature for Acme Storefront.\n' +
          'When the strategy is complete, save it to artifacts/product/product-strategy-smart-cart.md.\n',

        completion: {
          max_turns: 25,
          signal: 'artifacts/product/product-strategy-*.md',
        },

        reactions: [
          { when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich', reply: 'Skip' },
          { when: 'start.*scratch|from scratch|continue.*left off|start.*strategy', reply: 'Start strategy from scratch' },
          { when: 'missing|proceed.*assumption|how.*proceed|critical.*missing', reply: 'Proceed with assumptions' },
          { when: 'gameplan|domain.*game|roadmap', reply: 'No roadmap available, proceed without it' },
          { when: "annual.*plan.*not found|can't find.*annual|add.*annual.*plan", reply: 'Proceed without it' },
          { when: 'direction.*[ABC]|which.*option|choose.*direction|Direction \\d|Option [ABC]', reply: 'Go with your recommended direction' },
          {
            when: 'finalized product strategy|final product strategy|execution-ready KPI spec|PRD-ready strategy doc|save.*artifacts/product|saved to|next artifact',
            reply: 'Looks good — save the final strategy to artifacts/product/product-strategy-smart-cart.md',
          },
          { when: "correct\\?|right\\?|confirm|sound right|accurate\\?", reply: "Yes, that's correct" },
          { when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think', reply: 'Looks good — continue' },
          {
            when: '.*', once: true,
            reply: `It's about adding AI-powered product recommendations to the Acme Storefront
shopping cart. Store owners want to increase average order value by suggesting
relevant products at checkout. Let's start from scratch.\n`,
          },
        ],
      },

      workspace: WORKSPACE,
      graders: [checkStrategy, rubricStrategy],
    },

    {
      name: 'persona-smart-cart',
      type: 'conversation',
      conversation: {
        opener:
          "Let's shape the product strategy for a smart cart recommendations feature for Acme Storefront.\n" +
          'When the strategy is complete, save it to artifacts/product/product-strategy-smart-cart.md.\n',

        completion: {
          max_turns: 30,
          signal: 'artifacts/product/product-strategy-*.md',
        },

        persona: {
          description: `You are a product manager at Acme Commerce who has worked on the Storefront
platform for 3 years. You are focused on increasing average order value
for store owners. You communicate directly and concisely. When asked a
multiple-choice question, pick the most appropriate option. When asked
for confirmation or approval of a drafted section, approve it if the
content is reasonable and accurate. You're collaborative but don't
volunteer extra information unless asked. When the agent asks you to
choose between solution directions, pick the one the agent recommends.
If the strategy is complete or the agent asks what to do next, tell it
to save the final strategy to artifacts/product/product-strategy-smart-cart.md.\n`,
          facts: [
            'The feature is for the Acme Storefront platform — AI-powered cart recommendations',
            'Target users are Store Owners (online merchants managing their own shops)',
            'The main problem: store owners have low average order value because the cart has no recommendation capabilities',
            'Customers miss relevant complementary products during checkout',
            '67% of surveyed store owners report AOV below their target',
            'ShopEasy launched native AI cart recommendations in Q2 2025 — this is a competitive gap for Acme',
            'Current Acme "Related Products" widget is rule-based and only on product pages, not in the cart',
            'Third-party recommendation apps cost $30-100/month and have integration issues',
            'Mid-tier stores (50-500 products) are most affected — they cannot manually curate recommendations',
            'Fashion/apparel stores have the strongest natural cross-sell opportunity (outfit completion)',
            'The solution direction should be AI-powered, built natively into the cart experience',
            'No product roadmap link is available',
            'No GitHub repos to reference right now',
            'The project name should be smart-cart or similar',
            'The Acme Commerce 2026 annual plan emphasizes Growth and Speed as prime directives',
            'eCommerce goals include 25% GMV growth and 15% AOV improvement',
            'You want business KPIs focused on AOV increase, subscription conversion, and feature adoption',
            'When asked about kb-retrieval or MCP tools that fail, just say to skip it',
            'The final product strategy file should be saved to artifacts/product/product-strategy-smart-cart.md',
          ],
        },
      },

      workspace: WORKSPACE,
      graders: [checkStrategy, rubricStrategy],
    },
  ],
});
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/nadavlac/projects/pathgrade && npx vitest run tests/examples.product-strategy.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add examples/product-strategy/product-strategy.eval.ts
git commit -m "refactor: de-wix product-strategy eval config"
```

---

### Task 12: Refactor `product-strategy/graders/rubric-strategy.ts`

**Files:**
- Modify: `examples/product-strategy/graders/rubric-strategy.ts`

- [ ] **Step 1: Replace file content**

```typescript
import { llmRubricGrader } from '../../../src/core/grader-factories';

export const rubricStrategy = llmRubricGrader({
    rubric: `Evaluate the agent's execution of the product-strategy skill across a multi-turn conversation.

Workflow Compliance (0-0.4):
- Did the agent follow the section-by-section workflow in order (Target Audience → Problem Statement → Intents & Feelings → Solution Statement → Product Solution Summary → Why Now & KPIs)?
- Did the agent work on ONE section at a time, waiting for user approval before moving to the next?
- Did the agent use structured choices (ask-user tool or multiple choice options) for decision points?
- Did the agent scan for and acknowledge input artifacts (project brief, research) in Step 0?
- Did the agent handle the annual plan check in Step 5 (found it or asked how to proceed)?

Content Quality (0-0.4):
- Does the Target Audience section include Primary User with User Impact and Business Impact?
- Does the Problem Statement use the 5 Whys method and show the reasoning chain?
- Do Intents & Feelings use first-person format ("I want to...") with numbered intent IDs (#int-001)?
- Is the Solution Statement a concise direction (not features or UI details)?
- Does the Product Solution Summary include concrete capabilities, feasibility, and V1 vs later scope?
- Does Why Now reference specific evidence or strategic alignment (e.g., annual plan, competitive gap)?
- Are KPIs measurable with directional indicators (↑/↓), and never using NPS?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary repetition or excessive back-and-forth)?
- Did the agent adapt naturally to user responses?
- Did the agent present drafted sections before asking for approval (not just asking questions endlessly)?
- Was the final document saved to the correct path (artifacts/product/product-strategy-*.md)?`,
    weight: 0.5,
});
```

- [ ] **Step 2: Commit**

```bash
git add examples/product-strategy/graders/rubric-strategy.ts
git commit -m "refactor: de-wix product-strategy rubric grader"
```

---

### Task 13: Refactor `product-strategy/skill/SKILL.md`

**Files:**
- Modify: `examples/product-strategy/skill/SKILL.md`

Key changes:
- Frontmatter `name: ck-product-strategy` → `name: product-strategy`
- Delete ext-loading block (lines 11-13)
- Line 55: `/ck-product-strategy` → `/product-strategy`
- Line 100: "matters to Wix" → "matters to Acme Commerce"
- Line 167: "align with Wix plan" → "align with Acme Commerce plan"
- Lines 21-22: replace `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval` with `the kb-retrieval MCP tool`
- All references to "Wix" → "Acme Commerce"
- "Domain Gameplan" → "Product Roadmap" throughout
- "cross-Wix" → "cross-platform" (line 207)

- [ ] **Step 1: Apply all replacements**

The changes are systematic find-and-replace throughout the file:

1. Frontmatter: `name: product-strategy`
2. Delete lines 11-13 (ext-loading block)
3. Replace `ck-product-strategy` → `product-strategy` (line 3, 55)
4. Replace "matters to Wix" → "matters to the business" (line 100)
5. Replace "align with Wix plan" → "align with company plan" (line 167)
6. Replace all `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval kb-retrieval__retrieve_relevant_documents_from_kb` with `the kb-retrieval MCP tool` (appears in reference.md, not SKILL.md — but check)
7. Replace "Wix gameplan" → "company roadmap" (line 165)
8. Replace "Wix plan" → "company plan" (line 167)
9. Replace "Domain Gameplan" → "Product Roadmap" (line 164)

- [ ] **Step 2: Verify no Wix references remain**

```bash
grep -i "wix\|ck-product-strategy\|ck-shared\|wixpress\|creator-kit\|CreatorKit\|gameplan" examples/product-strategy/skill/SKILL.md
```

Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add examples/product-strategy/skill/SKILL.md
git commit -m "refactor: de-wix product-strategy SKILL.md"
```

---

### Task 14: Refactor `product-strategy/skill/reference.md`

**Files:**
- Modify: `examples/product-strategy/skill/reference.md`

Key changes:
- User taxonomy table (lines 24-34): Self-Creator → Store Owner, Partner → Agency, UoU → Shopper, Developer unchanged, Studio User → Power User
- All `npx -y --registry "https://npm.dev.wixpress.com" @wix/creator-kit@latest mcp-s kb-retrieval` → `the kb-retrieval MCP tool`
- "matters to Wix" → "matters to the business" (lines 22, 43, 53, 59)
- "Wix user taxonomy" → "platform user taxonomy" (lines 16, 24)
- "Wix Impact KPIs" → "Platform Impact KPIs" (lines 364, 371, 398)
- "↑ Premium upgrades" → "↑ Subscription upgrades" (line 373)
- "↑ GPV per Self-Creator" → "↑ GMV per Store Owner" (line 377)
- "↑ PREX score" → remove (line 381)
- "Wix gameplan" → "company roadmap" (lines 317, 321, 323, 327, 360)
- "Wix annual plan" → "company annual plan"
- "Wix knowledge base" → "knowledge base"
- "Wix goals" → "company goals" (line 356)
- "cross-Wix" → "cross-platform" (line 207)
- "leveraging an existing Wix product" → "leveraging an existing platform product" (line 212)

- [ ] **Step 1: Apply all replacements systematically**

Make each replacement as listed above. The changes are all text substitutions — no structural changes.

- [ ] **Step 2: Verify no Wix references remain**

```bash
grep -i "wix\|Self-Creator\|Studio User\|wixpress\|creator-kit\|gameplan\|PREX" examples/product-strategy/skill/reference.md
```

Expected: No output.

- [ ] **Step 3: Commit**

```bash
git add examples/product-strategy/skill/reference.md
git commit -m "refactor: de-wix product-strategy reference.md"
```

---

### Task 15: Rewrite `product-strategy/fixtures/annual-plan.md` (condensed)

**Files:**
- Modify: `examples/product-strategy/fixtures/annual-plan.md`

- [ ] **Step 1: Replace file content**

```markdown
## 2026 Annual Plan (Summary)

### Vision

Where anyone can build and grow their online business.

### 2026 Prime Directives

**Growth and Speed.** These are the prime directives for 2026. Growth means acquiring new users, converting them to paid plans, and expanding revenue per user. Speed means shipping faster, iterating faster, and responding to market changes faster.

### Key Strategic Themes

1. **AI-First Product Experience** — Embed AI across all products to reduce friction, automate repetitive tasks, and surface insights that help merchants grow their business.

2. **eCommerce Expansion** — Grow Acme Storefront into a full-featured commerce platform that competes with ShopEasy on capability while maintaining Acme's ease-of-use advantage. Key areas: payments, fulfillment, cart experience, and merchant analytics.

3. **Platform Extensibility** — Provide robust APIs, SDKs, and developer tools so third-party developers and agencies can build on Acme Commerce.

4. **Store Owner Monetization** — Help Store Owners generate more revenue through their online stores. Increase GMV, AOV, and conversion rates across commerce verticals.

5. **Agency & Developer Ecosystem** — Expand the platform for agencies, freelancers, and developers building on Acme Commerce.

### eCommerce Goals for 2026

- Increase Acme Storefront GMV by 25% YoY
- Improve average merchant AOV by 15%
- Reduce cart abandonment rate by 5 percentage points
- Launch native AI-powered commerce features (recommendations, dynamic pricing, inventory forecasting)
- Close competitive gaps with ShopEasy on core merchant tools

### Company-Wide Metrics

- Paid subscription growth: 18% YoY
- Revenue per user: increase 12% YoY
- New user acquisition: 20% YoY growth
- Feature adoption rate for AI features: target 40% within 6 months of launch

### Innovation Projects

Forward-looking initiatives: Acme AI Assistant, Headless Commerce API, Marketplace 2.0, Commerce Analytics Dashboard, Merchant Copilot.
```

- [ ] **Step 2: Commit**

```bash
git add examples/product-strategy/fixtures/annual-plan.md
git commit -m "refactor: rewrite fixtures annual plan for Acme Commerce"
```

---

### Task 16: Rewrite `product-strategy/skill/annual-plan.md` (full-length)

**Files:**
- Modify: `examples/product-strategy/skill/annual-plan.md`

- [ ] **Step 1: Replace with full-length Acme Commerce annual plan**

Write a narrative-style annual plan (~80-100 lines) covering:
- Company background and 2025 achievements
- Vision: "Where anyone can build and grow their online business"
- Market context (AI acceleration, competitive landscape, ShopEasy as primary competitor)
- 2026 Prime Directives: Growth and Speed (same messaging as condensed version)
- Key Strategic Themes (same 5 themes, but with 2-3 paragraph detail for each)
- eCommerce expansion detail (Acme Storefront goals, merchant analytics, cart experience)
- Platform extensibility (Acme SDK, APIs, headless commerce)
- Store Owner monetization strategies
- Company-wide metrics
- Innovation projects (Acme AI Assistant, Headless Commerce API, Marketplace 2.0, etc.)

Must be consistent with the condensed version in Task 15. No Wix, Shopify, or real company references.

- [ ] **Step 2: Verify consistency with condensed version**

```bash
# Check that key metrics match between both files
grep "25%" examples/product-strategy/skill/annual-plan.md
grep "25%" examples/product-strategy/fixtures/annual-plan.md
```

Expected: Both mention 25% GMV growth.

- [ ] **Step 3: Commit**

```bash
git add examples/product-strategy/skill/annual-plan.md
git commit -m "refactor: rewrite skill annual plan for Acme Commerce"
```

---

### Task 17: Refactor `product-strategy/fixtures/artifacts/`

**Files:**
- Modify: `examples/product-strategy/fixtures/artifacts/project-brief-smart-cart.md`
- Modify: `examples/product-strategy/fixtures/artifacts/discovery/user-voice-smart-cart.md`
- Modify: `examples/product-strategy/fixtures/artifacts/discovery/competitor-analysis-smart-cart.md`

- [ ] **Step 1: Update project-brief-smart-cart.md**

```markdown
# Project Brief: Smart Cart

## Context

Acme Storefront currently offers a basic shopping cart that lists selected items and allows checkout. There is no intelligence in the cart experience — it does not suggest related products, upsells, or bundles. Store owners have been requesting cart-level recommendations to increase average order value (AOV).

The current "Related Products" widget is available only on product pages, uses manual rule-based selection, and is underutilized — only 12% of stores with 50+ products have any cross-sell configured. Third-party recommendation apps cost merchants $30–100/month and often have integration issues.

ShopEasy launched native AI cart recommendations in Q2 2025, creating a competitive gap for Acme.

## Direction

Build AI-powered product recommendations directly into the Acme Storefront shopping cart, helping store owners increase AOV through contextual cross-sells and upsells without requiring manual curation.

## Goal

Solve user pain point — store owners lack tools to increase AOV, and customers miss relevant complementary products during checkout.

## Target Group

Store Owners who run online stores on Acme Storefront, particularly mid-tier stores with 50–500 products.

## Domain References

- Domain: Acme Storefront / eCommerce
- KB ID: storefront-cart-experience
```

- [ ] **Step 2: Update user-voice-smart-cart.md**

```markdown
# User Voice Research: Smart Cart Recommendations

## Summary

Analysis of 340+ support tickets, forum posts, and feature requests related to cart experience and product recommendations (Q3–Q4 2025).

## Key Findings

### Pain Point 1: Low Average Order Value

- 67% of store owners surveyed report AOV below their target
- "I wish Acme would suggest related products in the cart like MegaMart does" — recurring theme (45 mentions)
- Store owners manually create discount bundles as a workaround, spending ~2 hrs/week on curation

### Pain Point 2: No Cart-Level Recommendations

- Acme offers a "Related Products" widget for product pages, but nothing in the cart
- 23% of stores using third-party recommendation apps report integration issues (broken layouts, slow load times)
- "By the time customers are in the cart, they've already decided. I need to catch them earlier OR make the cart smarter" — store owner forum post

### Pain Point 3: Limited Cross-Sell Tools

- Current "You might also like" widget is rule-based (manual selection), not algorithmic
- Store owners with 100+ products find manual curation impossible
- Average store with 50+ products: only 12% have any cross-sell configured

## User Segments Most Affected

| Segment | Size estimate | AOV range | Key need |
|---------|--------------|-----------|----------|
| Mid-tier stores (50–500 products) | ~120K active stores | $30–80 | Automated recommendations — can't manually curate |
| Fashion/apparel stores | ~45K active stores | $40–65 | Outfit completion / "complete the look" |
| Home & decor stores | ~28K active stores | $50–120 | Complementary items (e.g., vase + flowers) |

## Quantified Impact

- Stores using third-party recommendation apps see 8–15% AOV lift on average
- Estimated revenue opportunity: if 50K stores adopt and see 10% AOV lift on a $50 average → ~$25M incremental GMV annually
- Current cart abandonment rate across Acme Storefront: 68% (industry benchmark: 70%)
```

- [ ] **Step 3: Update competitor-analysis-smart-cart.md**

```markdown
# Competitor Analysis: Cart Recommendations

## Summary

Analysis of cart-level recommendation features across 5 key competitors and 3 ShopEasy apps (conducted Q4 2025).

## Competitors Analyzed

### ShopEasy (Native)

- Offers "Cart recommendations" via ShopEasy AI (AI-powered)
- Launched Q2 2025; available on all paid plans
- Shows 2–4 recommended products below cart items
- Uses purchase history + browsing behavior + product embeddings
- Early data: merchants report 8–12% AOV lift

### CartCloud

- No native cart recommendations
- Relies on third-party apps (Rebuy, Bold Commerce)
- Average app cost: $29–99/month
- Setup complexity cited as friction for smaller merchants

### SquareSite

- "Related products" on product pages only
- No cart-level recommendations
- Limited AI/ML features for eCommerce

### OpenCart Pro

- Plugin-dependent (Cart Add-Ons, YITH equivalents)
- Fragmented experience; quality varies by plugin
- No AI-native solution; mostly rule-based

### MegaMart (benchmark, not direct competitor)

- "Frequently bought together" and "Customers also bought" in cart
- Drives estimated 35% of total revenue through recommendations
- Gold standard for AI-powered cross-sell UX

## Competitive Gap Analysis

| Feature | Acme | ShopEasy | CartCloud | SquareSite |
|---------|------|----------|-----------|------------|
| Product page recs | Rule-based | AI-powered | App-dependent | Basic |
| Cart recs | None | AI-powered | App-dependent | None |
| AI/ML recommendations | None | Yes (AI) | No | No |
| Built-in (no extra cost) | N/A | Yes | No | N/A |

## Key Takeaways

- ShopEasy is the only major platform with native AI cart recommendations
- This is an active competitive gap for Acme — ShopEasy merchants already have this capability
- Third-party solutions cost merchants $30–100/month — Acme can offer a built-in advantage at no extra cost
- The cart is underutilized real estate across all platforms except ShopEasy
- AI-powered recommendations significantly outperform rule-based ones (3–5x engagement)
```

- [ ] **Step 4: Commit**

```bash
git add examples/product-strategy/fixtures/
git commit -m "refactor: de-wix product-strategy fixtures"
```

---

### Task 18: Refactor `product-strategy` plugin metadata

**Files:**
- Modify: `examples/product-strategy/skill/.claude-plugin/plugin.json`

- [ ] **Step 1: Update plugin.json**

```json
{
  "name": "product-strategy",
  "version": "1.0.0",
  "description": "Plugin-style metadata for the product-strategy skill."
}
```

- [ ] **Step 2: Verify openai.yaml has no Wix refs**

```bash
cat examples/product-strategy/skill/agents/openai.yaml
```

Expected: Only `policy: allow_implicit_invocation: false`.

- [ ] **Step 3: Commit**

```bash
git add examples/product-strategy/skill/.claude-plugin/plugin.json
git commit -m "refactor: de-wix product-strategy plugin metadata"
```

---

### Task 19: Final verification — full test suite and grep

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/nadavlac/projects/pathgrade && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Grep for ANY remaining Wix references across both examples**

```bash
grep -ri "wix\|CreatorKit\|ck-new\|ck-product-strategy\|ck-shared\|wixpress\|wewix\|mcp-s \|creator-kit\|Self-Creator\|Studio User\|Rise\.ai\|gameplan\|Shopify\|BigCommerce\|Squarespace\|WooCommerce\|Amazon" examples/project-intake/ examples/product-strategy/
```

Expected: No output. If any matches found, fix them.

- [ ] **Step 3: Check outside files for stale references**

```bash
grep -ri "ck-new\|ck-product-strategy" pathgrade.eval.ts README.md
```

Expected: No output. (Root `pathgrade.eval.ts` doesn't reference examples. Root `README.md` only mentions `superlint` and `angular-modern`.)

- [ ] **Step 4: Commit any final fixes**

If fixes were needed:

```bash
git add -A
git commit -m "fix: remove remaining Wix references"
```
