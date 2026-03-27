import { defineEval } from '@wix/pathgrade';

const WORKSPACE = [
  {
    src: 'fixtures/artifacts/project-brief-smart-cart.md',
    dest: 'artifacts/project-brief-smart-cart.md',
  },
  {
    src: 'fixtures/artifacts/discovery/user-voice-smart-cart.md',
    dest: 'artifacts/discovery/user-voice-smart-cart.md',
  },
  {
    src: 'fixtures/artifacts/discovery/competitor-analysis-smart-cart.md',
    dest: 'artifacts/discovery/competitor-analysis-smart-cart.md',
  },
  { src: 'fixtures/annual-plan.md', dest: 'annual-plan.md' },
];

const DETERMINISTIC_GRADER = {
  type: 'deterministic' as const,
  run: 'node graders/check-strategy.js',
  weight: 0.5,
};

const LLM_RUBRIC_GRADER = {
  type: 'llm_rubric' as const,
  rubric: `Evaluate the agent's execution of the ck-product-strategy skill across a multi-turn conversation.

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
};

export default defineEval({
  skillPath: 'skill',

  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 1800,
    threshold: 0.6,
  },

  tasks: [
    // ── Scripted: pre-defined replies walk through all strategy steps ──
    {
      name: 'scripted-smart-cart',
      type: 'conversation',
      conversation: {
        opener:
          'I want to work on product strategy for our smart cart feature for Wix Stores.\n',

        completion: {
          max_turns: 25,
          signal: 'artifacts/product/product-strategy-*.md',
        },

        // NOTE: pathgrade consumes each pattern reply after first match (splice).
        // Replies that must fire multiple times need duplicate entries.
        replies: [
          // First reply (no when): provide context and confirm start
          {
            content: `It's about adding AI-powered product recommendations to the Wix Stores
shopping cart. Store owners want to increase average order value by suggesting
relevant products at checkout. Let's start from scratch.\n`,
          },

          // KB enrichment fails in eval (no MCP) — may happen at multiple steps
          { content: 'Skip', when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich' },
          { content: 'Skip', when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich' },
          { content: 'Skip', when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich' },

          // Start fresh confirmation
          {
            content: 'Start strategy from scratch',
            when: 'start.*scratch|from scratch|continue.*left off|start.*strategy',
          },

          // Missing research — proceed with assumptions
          {
            content: 'Proceed with assumptions',
            when: 'missing|proceed.*assumption|how.*proceed|critical.*missing',
          },

          // Domain gameplan — skip
          {
            content: 'No gameplan available, proceed without it',
            when: 'gameplan|domain.*game',
          },

          // Annual plan not found (shouldn't happen since it's in workspace, but just in case)
          {
            content: 'Proceed without it',
            when: "annual.*plan.*not found|can't find.*annual|add.*annual.*plan",
          },

          // Solution direction choice — go with recommendation (may happen twice: choose + confirm)
          {
            content: 'Go with your recommended direction',
            when: 'direction.*[ABC]|which.*option|choose.*direction|Direction \\d|Option [ABC]',
          },
          {
            content: 'Go with your recommended direction',
            when: 'direction.*[ABC]|which.*option|choose.*direction|Direction \\d|Option [ABC]',
          },

          // General confirmation — multiple copies for various confirmation prompts
          { content: "Yes, that's correct", when: "correct\\?|right\\?|confirm|sound right|accurate\\?" },
          { content: "Yes, that's correct", when: "correct\\?|right\\?|confirm|sound right|accurate\\?" },
          { content: "Yes, that's correct", when: "correct\\?|right\\?|confirm|sound right|accurate\\?" },

          // Section approval — one per section step (TA, Problem, Intents, Solution,
          // Solution Summary, Why Now+KPIs, plus buffer for extra approval rounds)
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
          { content: 'Looks good — continue', when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think' },
        ],
      },

      workspace: WORKSPACE,
      graders: [DETERMINISTIC_GRADER, LLM_RUBRIC_GRADER],
    },

    // ── Persona: LLM-simulated PM responds naturally ──────────────────
    {
      name: 'persona-smart-cart',
      type: 'conversation',
      conversation: {
        opener:
          "Let's shape the product strategy for a smart cart recommendations feature for Wix Stores.\n",

        completion: {
          max_turns: 30,
          signal: 'artifacts/product/product-strategy-*.md',
        },

        persona: {
          description: `You are a product manager at Wix who has worked on the Stores
platform for 3 years. You are focused on increasing average order value
for store owners. You communicate directly and concisely. When asked a
multiple-choice question, pick the most appropriate option. When asked
for confirmation or approval of a drafted section, approve it if the
content is reasonable and accurate. You're collaborative but don't
volunteer extra information unless asked. When the agent asks you to
choose between solution directions, pick the one the agent recommends.\n`,
          facts: [
            'The feature is for the Wix Stores platform — AI-powered cart recommendations',
            'Target users are Self-Creators (online store owners managing their own shops)',
            'The main problem: store owners have low average order value because the cart has no recommendation capabilities',
            'Customers miss relevant complementary products during checkout',
            '67% of surveyed store owners report AOV below their target',
            'Shopify launched native AI cart recommendations in Q2 2025 — this is a competitive gap for Wix',
            'Current Wix "Related Products" widget is rule-based and only on product pages, not in the cart',
            'Third-party recommendation apps cost $30-100/month and have integration issues',
            'Mid-tier stores (50-500 products) are most affected — they cannot manually curate recommendations',
            'Fashion/apparel stores have the strongest natural cross-sell opportunity (outfit completion)',
            'The solution direction should be AI-powered, built natively into the cart experience',
            'No domain gameplan link is available',
            'No GitHub repos to reference right now',
            'The project name should be smart-cart or similar',
            'The Wix 2026 annual plan emphasizes Growth and Speed as prime directives',
            'eCommerce goals include 25% GMV growth and 15% AOV improvement',
            'You want business KPIs focused on AOV increase, Premium conversion, and feature adoption',
            'When asked about kb-retrieval or MCP tools that fail, just say to skip it',
          ],
        },
      },

      workspace: WORKSPACE,
      graders: [DETERMINISTIC_GRADER, LLM_RUBRIC_GRADER],
    },
  ],
});
