import { describe, expect, it } from 'vitest';
import { planRuntimePolicies, NONINTERACTIVE_RUNTIME_POLICY, renderRuntimePolicy } from '../src/sdk/runtime-policy.js';

describe('runtime policy planning', () => {
  it('plans the non-interactive runtime policy for Claude sessions', () => {
    expect(planRuntimePolicies('claude')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
  });

  it('plans the non-interactive runtime policy for Codex transcript sessions', () => {
    expect(planRuntimePolicies('codex')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
  });

  it('renders the Claude policy as a hard execution contract', () => {
    const rendered = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'claude' });

    expect(rendered).toContain('blocked checkpoint');
    expect(rendered).toContain('AskUserQuestion');
    expect(rendered).toContain('must not retry');
  });

  it('renders the Codex policy with the Codex interactive tool name', () => {
    const rendered = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'codex' });

    expect(rendered).toContain('request_user_input');
    expect(rendered).toContain('blocked checkpoint');
  });

  it('renders the Cursor policy with the Cursor interactive tool name', () => {
    const rendered = renderRuntimePolicy(NONINTERACTIVE_RUNTIME_POLICY, { agent: 'cursor' });

    expect(rendered).toContain('AskQuestion');
    expect(rendered).not.toContain('AskUserQuestion');
    expect(rendered).toContain('blocked checkpoint');
  });
});
