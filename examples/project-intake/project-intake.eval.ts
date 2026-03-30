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
