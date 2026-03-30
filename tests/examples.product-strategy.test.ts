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
