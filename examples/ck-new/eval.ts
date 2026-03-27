import { defineEval } from '../../src/core/define-eval';

export default defineEval({
  skillPath: 'skill',

  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.6,
  },

  tasks: [
    // ── Tool-aware bug fix ──────────────────────────────────────
    {
      name: 'tool-aware-fix',
      type: 'instruction',
      instruction: 'Read app.js, find the bug in the add function, and fix it so add(2,3) returns 5.',
      agent: 'claude',
      workspace: [
        { src: 'fixtures/buggy-app.js', dest: 'app.js' },
        { src: 'fixtures/solve-fix.sh', dest: 'solve-fix.sh' },
      ],
      solution: 'solve-fix.sh',
      trials: 1,
      timeout: 120,
      graders: [
        {
          type: 'deterministic',
          run: 'node graders/check-fix.js',
          weight: 0.6,
        },
        {
          type: 'tool_usage',
          weight: 0.4,
          expectations: [
            { action: 'read_file', argument_pattern: 'app\\.js', min: 1, weight: 0.5 },
            { action: 'edit_file', min: 1, weight: 0.5 },
          ],
        },
      ],
    },


    // ── Scripted: all answers pre-defined ─────────────────────────
    {
      name: 'scripted-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a gift card feature.\n`,

        completion: {
          max_turns: 12,
          signal: 'artifacts/project-brief-*.md',
          timeout: 300,
        },

        replies: [
          {
            content: `It's for the Wix Stores platform. Online store owners have been
requesting the ability to sell digital gift cards that customers
can purchase and redeem at checkout.\n`,
          },
          {
            content: "Yes, that's right",
            when: "right\\?|correct\\?|confirm|sound right",
          },
          {
            content: 'Solve user pain point',
            when: 'goal|trying to achieve|what are you trying',
          },
          {
            content: 'Self-Creator',
            when: 'target|audience|who|Self-Creator|adjust if needed',
          },
          // KB enrichment fails in eval (no MCP) — agent asks to paste doc or skip.
          // Must come BEFORE the gameplan pattern since KB message also contains "gameplan".
          {
            content: 'Skip',
            when: 'knowledge base|KB.*MCP|enrich.*brief|paste.*doc.*skip',
          },
          {
            content: 'Skip for now',
            when: 'gameplan|strategy doc',
          },
          {
            content: 'Looks good, no changes',
            when: "look right|approve|feedback|changes|edit|you'd change|anything.*change|move on|before moving",
          },
          {
            content: 'No, skip repos for now',
            when: 'github|repo|reference',
          },
        ],
      },

      graders: [
        {
          type: 'deterministic',
          run: 'node graders/check-brief.js',
          weight: 0.5,
        },
        {
          type: 'llm_rubric',
          rubric: `Evaluate the multi-turn conversation for ck-new skill compliance.

Workflow (0-0.4):
- Did the agent ask questions one at a time (not multiple in one message)?
- Did the agent follow check→direction→goal→target flow?
- Did it offer structured choices for Goal and Target Group?

Brief Quality (0-0.4):
- Is the brief at artifacts/project-brief-*.md?
- Does it have all required sections (Context, Direction, Goal, Target Group)?
- Is content refined (not just echoing user replies)?

Conversation Quality (0-0.2):
- Was the conversation efficient (no unnecessary back-and-forth)?
- Did the agent react naturally to user responses?`,
          weight: 0.5,
        },
      ],
    },

    // ── Persona: LLM-simulated PM ────────────────────────────────
    {
      name: 'persona-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a feature
related to gift cards for online stores.\n`,

        completion: {
          max_turns: 15,
          signal: 'artifacts/project-brief-*.md',
          timeout: 300,
        },

        persona: {
          description: `You are a product manager at Wix who has worked on the Stores
platform for 2 years. You communicate directly and concisely.
When asked a multiple-choice question, pick the most appropriate
option. When asked for confirmation, confirm if correct. You're
collaborative but don't volunteer extra information unless asked.\n`,
          facts: [
            'The feature is for the Wix Stores platform',
            'Target users are Self-Creators (store owners managing their own shops)',
            'Goal: solve user pain point — store owners can\'t offer gift cards and lose revenue',
            'Direction: custom gift card designs, set denominations, email delivery, checkout redemption',
            'You don\'t know technical implementation details',
            'No GitHub repos to link right now',
            'No gameplan link available',
            'The project name should be \'gift-card\' or similar',
          ],
        },

      },

      graders: [
        {
          type: 'deterministic',
          run: 'node graders/check-brief.js',
          weight: 0.5,
        },
        {
          type: 'llm_rubric',
          rubric: `Evaluate the full persona-driven conversation.

Skill Discovery (0-0.2):
- Did the agent discover and use ck-new?

Conversation Flow (0-0.4):
- One question per turn?
- Adapted to user's communication style?
- Handled open-ended responses well?

Brief Quality (0-0.4):
- Complete brief with all sections?
- Content matches the facts the persona provided?
- Project name reasonable?`,
          weight: 0.5,
        },
      ],
    },
  ],
});
