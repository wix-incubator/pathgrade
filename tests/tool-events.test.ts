import { describe, it, expect } from 'vitest';
import { extractCodexToolEvents } from '../src/agents/codex.js';
import { extractSkillsFromToolEvents, extractSkillNameFromPath, TOOL_NAME_MAP, buildSummary } from '../src/tool-events.js';
import type { ToolEvent } from '../src/tool-events.js';

// The Claude-specific NDJSON `extractClaudeStreamJsonEvents` describe block
// that used to live here (~180 lines) has been removed. The SDK driver no
// longer scrapes NDJSON; tool events are projected from the typed
// `SDKMessage` stream by `projectSdkMessages`. The replacement tests live
// in `tests/claude-sdk-projector.test.ts`. See issue #002.

describe('extractCodexToolEvents', () => {
  it('normalizes Codex shell and file-read traces', () => {
    const trace = [
      'Some assistant text before tools',
      'tool: exec_command {"cmd":"rg foo src"}',
      'tool: localGetFileContent {"path":"src/app.ts"}',
      'Some text after',
    ].join('\n');
    const events = extractCodexToolEvents(trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'run_shell', providerToolName: 'exec_command', provider: 'codex' }),
      expect.objectContaining({ action: 'read_file', providerToolName: 'localGetFileContent', provider: 'codex' }),
    ]);
  });

  it('normalizes Codex shell and file-read traces via generic tool line parser', () => {
    const trace = [
      'tool: exec_command {"cmd":"npm test"}',
      'tool: read_file {"path":"src/index.ts"}',
    ].join('\n');
    const events = extractCodexToolEvents(trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'run_shell', providerToolName: 'exec_command', provider: 'codex' }),
      expect.objectContaining({ action: 'read_file', providerToolName: 'read_file', provider: 'codex' }),
    ]);
  });

  it('returns empty array when no recognizable tool trace is present', () => {
    expect(extractCodexToolEvents('plain assistant text')).toEqual([]);
  });

  it('extracts tool events from current Codex exec and file update traces', () => {
    const trace = [
      'OpenAI Codex v0.117.0-alpha.10 (research preview)',
      'exec',
      '/bin/zsh -lc "sed -n \'1,200p\' app.js" in /tmp/workspace succeeded in 0ms:',
      '// A simple calculator module',
      'file update',
      'M /tmp/workspace/app.js',
      '@@ -2,3 +2,3 @@',
      'apply_patch(auto_approved=true) exited 0 in 44ms:',
      'Success. Updated the following files:',
      'M /tmp/workspace/app.js',
      'exec',
      '/bin/zsh -lc "node -e \\"const { add } = require(\'./app\'); console.log(add(2,3))\\"" in /tmp/workspace succeeded in 0ms:',
      '5',
    ].join('\n');

    const events = extractCodexToolEvents(trace, 1);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'read_file',
          provider: 'codex',
          providerToolName: 'exec',
          turnNumber: 1,
        }),
        expect.objectContaining({
          action: 'edit_file',
          provider: 'codex',
          providerToolName: 'file update',
          turnNumber: 1,
        }),
        expect.objectContaining({
          action: 'run_shell',
          provider: 'codex',
          providerToolName: 'exec',
          turnNumber: 1,
        }),
      ]),
    );

    expect(events.find((event) => event.action === 'read_file')?.summary).toContain("sed -n '1,200p' app.js");
    expect(events.find((event) => event.providerToolName === 'file update')?.arguments).toEqual({
      path: '/tmp/workspace/app.js',
    });
  });

  it('extracts tool events from split-line Codex exec and apply patch traces', () => {
    const trace = [
      'OpenAI Codex v0.119.0-alpha.28 (research preview)',
      'exec',
      "/bin/zsh -lc 'sed -n \"1,200p\" calc.js' in /tmp/workspace",
      ' succeeded in 0ms:',
      '// calculator source',
      'apply patch',
      'patch: completed',
      '/tmp/workspace/calc.js',
      'diff --git a/calc.js b/calc.js',
      'exec',
      "/bin/zsh -lc 'node calc.test.js' in /tmp/workspace",
      ' succeeded in 0ms:',
      'All tests passed',
    ].join('\n');

    const events = extractCodexToolEvents(trace, 2);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'read_file',
          provider: 'codex',
          providerToolName: 'exec',
          turnNumber: 2,
          arguments: { command: `sed -n "1,200p" calc.js` },
        }),
        expect.objectContaining({
          action: 'edit_file',
          provider: 'codex',
          providerToolName: 'apply patch',
          turnNumber: 2,
          arguments: { path: '/tmp/workspace/calc.js' },
        }),
        expect.objectContaining({
          action: 'run_shell',
          provider: 'codex',
          providerToolName: 'exec',
          turnNumber: 2,
          arguments: { command: 'node calc.test.js' },
        }),
      ]),
    );
  });

  it('caps rawSnippet at 200 characters', () => {
    const longCmd = 'x'.repeat(300);
    const trace = `tool: exec_command {"cmd":"${longCmd}"}`;
    const events = extractCodexToolEvents(trace);
    expect(events).toHaveLength(1);
    expect(events[0].rawSnippet.length).toBeLessThanOrEqual(200);
  });

  it('preserves turnNumber when provided', () => {
    const trace = 'tool: exec_command {"cmd":"ls"}';
    const events = extractCodexToolEvents(trace, 3);
    expect(events[0].turnNumber).toBe(3);
  });

  it('maps common tool names to normalized actions', () => {
    const trace = [
      'tool: write_file {"path":"out.txt","content":"hi"}',
      'tool: edit_file {"path":"src/app.ts","old":"a","new":"b"}',
      'tool: localSearchCode {"pattern":"TODO"}',
      'tool: list_files {"path":"src"}',
    ].join('\n');
    const events = extractCodexToolEvents(trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'write_file' }),
      expect.objectContaining({ action: 'edit_file' }),
      expect.objectContaining({ action: 'search_code' }),
      expect.objectContaining({ action: 'list_files' }),
    ]);
  });

  it("normalizes Codex's native request_user_input tool to ask_user action", () => {
    const trace = 'tool: request_user_input {"questions":[{"id":"q1","question":"ok?"}]}';
    const events = extractCodexToolEvents(trace);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'ask_user',
        providerToolName: 'request_user_input',
        provider: 'codex',
      }),
    ]);
  });
});

describe('extractSkillsFromToolEvents', () => {
  const makeEvent = (overrides: Partial<ToolEvent>): ToolEvent => ({
    action: 'unknown',
    provider: 'claude',
    providerToolName: 'unknown',
    summary: '',
    confidence: 'high',
    rawSnippet: '',
    ...overrides,
  });

  it('returns unique skill names from use_skill events', () => {
    const events = [
      makeEvent({ action: 'use_skill', skillName: 'tdd' }),
      makeEvent({ action: 'use_skill', skillName: 'debugging' }),
      makeEvent({ action: 'use_skill', skillName: 'tdd' }),  // duplicate
      makeEvent({ action: 'read_file' }),  // not a skill
    ];
    expect(extractSkillsFromToolEvents(events)).toEqual(['tdd', 'debugging']);
  });

  it('returns empty array when no skills used', () => {
    const events = [
      makeEvent({ action: 'read_file' }),
      makeEvent({ action: 'run_shell' }),
    ];
    expect(extractSkillsFromToolEvents(events)).toEqual([]);
  });

  it('deduplicates across Skill tool and Read-on-SKILL.md for same skill', () => {
    const events = [
      makeEvent({ action: 'use_skill', providerToolName: 'Skill', skillName: 'tdd' }),
      makeEvent({ action: 'use_skill', providerToolName: 'Read', skillName: 'tdd' }),
    ];
    expect(extractSkillsFromToolEvents(events)).toEqual(['tdd']);
  });
});

describe('buildSummary ask_user special-case', () => {
  it('renders plural ask_user arguments using question count + header only', () => {
    const summary = buildSummary('ask_user', 'AskUserQuestion', {
      batchId: 'b1',
      questions: [
        { id: 'q1', header: 'Region', question: 'Which region?', isOther: false, isSecret: false, options: null },
        { id: 'q2', header: 'Region', question: 'Which sub-region?', isOther: false, isSecret: false, options: null },
      ],
    });
    expect(summary).toContain('2');
    expect(summary).toContain('Region');
  });

  it('never includes answer values, even if the caller wrongly placed them in arguments', () => {
    const summary = buildSummary('ask_user', 'AskUserQuestion', {
      batchId: 'b1',
      questions: [
        {
          id: 'q1',
          header: 'Token',
          question: 'API token?',
          isOther: false,
          isSecret: true,
          options: null,
          answer: { values: ['rotate-me'], source: 'reaction' },
        },
      ],
    });
    expect(summary).not.toContain('rotate-me');
  });

  it('renders sensibly even when header is missing', () => {
    const summary = buildSummary('ask_user', 'AskUserQuestion', {
      batchId: 'b1',
      questions: [
        { id: 'q1', question: 'Which region?', isOther: false, isSecret: false, options: null },
      ],
    });
    expect(summary).toContain('1');
    expect(summary).not.toContain('rotate-me');
  });
});

describe('TOOL_NAME_MAP ask_user normalization', () => {
  it.each([
    ['ask_user'],
    ['AskUserQuestion'],
    ['request_user_input'],
    ['AskQuestion'],
  ])('normalizes %s to the ask_user action', (providerToolName) => {
    expect(TOOL_NAME_MAP[providerToolName]).toBe('ask_user');
  });
});

describe('TOOL_NAME_MAP Cursor discriminants', () => {
  it.each([
    ['readToolCall', 'read_file'],
    ['editToolCall', 'edit_file'],
    ['globToolCall', 'list_files'],
    ['grepToolCall', 'search_code'],
    ['shellToolCall', 'run_shell'],
    ['webFetchToolCall', 'web_fetch'],
    ['updateTodosToolCall', 'update_todos'],
  ])('normalizes Cursor discriminant %s to %s', (discriminant, expected) => {
    expect(TOOL_NAME_MAP[discriminant]).toBe(expected);
  });

  it('maps Claude Code TodoWrite to update_todos', () => {
    expect(TOOL_NAME_MAP['TodoWrite']).toBe('update_todos');
  });

  it('leaves unknown Cursor discriminants absent from the map (caller falls back to unknown)', () => {
    expect(TOOL_NAME_MAP['unrecognizedToolCall']).toBeUndefined();
  });
});

describe('extractSkillNameFromPath', () => {
  it('extracts skill name from nested path', () => {
    expect(extractSkillNameFromPath('/workspace/.claude/skills/tdd/SKILL.md')).toBe('tdd');
    expect(extractSkillNameFromPath('.claude/skills/debugging/SKILL.md')).toBe('debugging');
  });

  it('returns undefined for bare SKILL.md without parent', () => {
    expect(extractSkillNameFromPath('SKILL.md')).toBeUndefined();
  });

  it('returns undefined for SKILL.md at filesystem root', () => {
    expect(extractSkillNameFromPath('/SKILL.md')).toBeUndefined();
  });

  it('returns undefined for non-SKILL.md files', () => {
    expect(extractSkillNameFromPath('/workspace/src/app.ts')).toBeUndefined();
    expect(extractSkillNameFromPath('/workspace/README.md')).toBeUndefined();
  });

  it('returns undefined for paths containing SKILL.md as substring', () => {
    expect(extractSkillNameFromPath('/workspace/MY_SKILL.md')).toBeUndefined();
    expect(extractSkillNameFromPath('/workspace/SKILL.md.bak')).toBeUndefined();
  });

  it('handles paths with trailing slash before SKILL.md', () => {
    expect(extractSkillNameFromPath('skills/tdd/SKILL.md')).toBe('tdd');
  });
});
