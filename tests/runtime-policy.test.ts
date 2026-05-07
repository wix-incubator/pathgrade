import { describe, expect, it } from 'vitest';
import { planRuntimePolicies, NONINTERACTIVE_RUNTIME_POLICY, renderRuntimePolicy } from '../src/sdk/runtime-policy.js';

describe('runtime policy planning', () => {
  it('plans no runtime policy for Claude sessions — capability is reliable', () => {
    // The SDK driver replaces the synthesis workaround with a live ask-user
    // bridge, so Claude's capability is `'reliable'` and
    // `planRuntimePolicies` returns an empty array. The renderer below still
    // works because the policy module stays in place to serve Codex (exec)
    // and Cursor.
    expect(planRuntimePolicies('claude')).toEqual([]);
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
