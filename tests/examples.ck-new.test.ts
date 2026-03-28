import { describe, it, expect } from 'vitest';
import config from '../examples/ck-new/ck-new.eval';

describe('examples/ck-new scripted-gift-card eval tuning', () => {
  it('packs the scripted confirmation reply with goal and target information Codex tends to need early', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-gift-card');
    const replies = scriptedTask?.conversation?.replies ?? [];
    const confirmReply = replies.find((reply) => reply.when?.includes('right\\?'));

    expect(confirmReply?.content).toContain('solve a user pain point');
    expect(confirmReply?.content).toContain('Self-Creator');
  });

  it('includes a scripted reply that nudges Codex to write the brief after vague progress checks', () => {
    const scriptedTask = config.tasks.find((task) => task.name === 'scripted-gift-card');
    expect(scriptedTask?.type).toBe('conversation');

    const replies = scriptedTask?.conversation?.replies ?? [];
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('write the brief'),
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
