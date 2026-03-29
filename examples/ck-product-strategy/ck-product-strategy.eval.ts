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
          'I want to work on product strategy for our smart cart feature for Wix Stores.\n' +
          'When the strategy is complete, save it to artifacts/product/product-strategy-smart-cart.md.\n',

        completion: {
          max_turns: 25,
          signal: 'artifacts/product/product-strategy-*.md',
        },

        reactions: [
          { when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich', reply: 'Skip' },
          { when: 'start.*scratch|from scratch|continue.*left off|start.*strategy', reply: 'Start strategy from scratch' },
          { when: 'missing|proceed.*assumption|how.*proceed|critical.*missing', reply: 'Proceed with assumptions' },
          { when: 'gameplan|domain.*game', reply: 'No gameplan available, proceed without it' },
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
            reply: `It's about adding AI-powered product recommendations to the Wix Stores
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
          "Let's shape the product strategy for a smart cart recommendations feature for Wix Stores.\n" +
          'When the strategy is complete, save it to artifacts/product/product-strategy-smart-cart.md.\n',

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
choose between solution directions, pick the one the agent recommends.
If the strategy is complete or the agent asks what to do next, tell it
to save the final strategy to artifacts/product/product-strategy-smart-cart.md.\n`,
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
            'The final product strategy file should be saved to artifacts/product/product-strategy-smart-cart.md',
          ],
        },
      },

      workspace: WORKSPACE,
      graders: [checkStrategy, rubricStrategy],
    },
  ],
});
