import { defineEval } from '../../src/core/define-eval';

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
        {
          type: 'deterministic',
          run: `if [ -f output.txt ] && grep -q "hello world" output.txt; then
  echo '{"score": 1.0, "details": "output.txt contains hello world"}'
else
  echo '{"score": 0.0, "details": "output.txt missing or wrong content"}'
fi`,
          weight: 1.0,
        },
      ],
    },
  ],
});
