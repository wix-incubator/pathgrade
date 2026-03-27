import { defineEval } from '../../src/core/define-eval';
import { checkOutput } from './graders/check-output';

export default defineEval({
  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
  },
  tasks: [
    {
      name: 'example-task',
      type: 'instruction',
      instruction: `This is an example eval.ts config.
It demonstrates a simple pathgrade eval configuration.

The agent should create a file called output.txt with "hello world".`,
      graders: [
        checkOutput,
      ],
    },
  ],
});
