import { describe, it, expect } from 'vitest';
import config from '../examples/ck-new/ck-new.eval';

describe('examples/ck-new scripted-gift-card eval tuning', () => {
  it('packs the scripted confirmation reply with goal and target information Codex tends to need early', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-gift-card');
    const reactions = (scriptedTask as any)?.conversation?.reactions ?? [];
    const confirmReaction = reactions.find((r: any) => r.when?.includes('right\\?'));

    expect(confirmReaction?.reply).toContain('solve a user pain point');
    expect(confirmReaction?.reply).toContain('Self-Creator');
  });

  it('includes a scripted reply that nudges Codex to write the brief after vague progress checks', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-gift-card');
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
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-gift-card');
    const rubric = scriptedTask?.graders.find((grader) => grader.type === 'llm_rubric')?.rubric;

    expect(rubric).toContain('flexible');
    expect(rubric).toContain('required topics');
    expect(rubric).not.toContain('check→direction→goal→target flow');
  });
});
