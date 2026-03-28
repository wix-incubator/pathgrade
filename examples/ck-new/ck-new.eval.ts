import { defineEval } from '../../src/core/define-eval';
import { checkFix } from './graders/check-fix';
import { checkBrief } from './graders/check-brief';
import { toolUsageFix } from './graders/tool-usage-fix';
import { rubricScripted } from './graders/rubric-scripted';
import { rubricPersona } from './graders/rubric-persona';

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
        { src: 'fixtures/buggy-app.js', dest: 'app.js' },
        { src: 'fixtures/solve-fix.sh', dest: 'solve-fix.sh' },
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
      name: 'scripted-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a gift card feature.\n`,
        completion: { max_turns: 12, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        replies: [
          { content: `It's for the Wix Stores platform. Online store owners have been\nrequesting the ability to sell digital gift cards that customers\ncan purchase and redeem at checkout.\n` },
          { content: "Yes, that's right", when: "right\\?|correct\\?|confirm|sound right" },
          { content: 'Solve user pain point', when: 'goal|trying to achieve|what are you trying' },
          { content: 'Self-Creator', when: 'target|audience|who|Self-Creator|adjust if needed' },
          { content: 'Skip', when: 'knowledge base|KB.*MCP|enrich.*brief|paste.*doc.*skip' },
          { content: 'Skip for now', when: 'gameplan|strategy doc' },
          { content: 'Looks good, no changes', when: "look right|approve|feedback|changes|edit|you'd change|anything.*change|move on|before moving" },
          { content: 'No, skip repos for now', when: 'github|repo|reference' },
        ],
      },
      graders: [
        checkBrief,
        rubricScripted,
      ],
    },

    {
      name: 'persona-gift-card',
      type: 'conversation',
      conversation: {
        opener: `I want to start a new project. I have an idea for a feature\nrelated to gift cards for online stores.\n`,
        completion: { max_turns: 15, signal: 'artifacts/project-brief-*.md', timeout: 300 },
        persona: {
          description: `You are a product manager at Wix who has worked on the Stores\nplatform for 2 years. You communicate directly and concisely.\nWhen asked a multiple-choice question, pick the most appropriate\noption. When asked for confirmation, confirm if correct. You're\ncollaborative but don't volunteer extra information unless asked.\n`,
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
        checkBrief,
        rubricPersona,
      ],
    },
  ],
});
