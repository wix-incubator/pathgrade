import { describe, it, expect } from 'vitest';
import { extractToolEvents } from '../src/tool-event-extractors';

describe('extractToolEvents', () => {
  it('normalizes Codex shell and file-read traces', () => {
    const trace = [
      'Some assistant text before tools',
      'tool: exec_command {"cmd":"rg foo src"}',
      'tool: localGetFileContent {"path":"src/app.ts"}',
      'Some text after',
    ].join('\n');
    const events = extractToolEvents('codex', trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'run_shell', providerToolName: 'exec_command', provider: 'codex' }),
      expect.objectContaining({ action: 'read_file', providerToolName: 'localGetFileContent', provider: 'codex' }),
    ]);
  });

  it('normalizes Gemini shell and file-read traces', () => {
    const trace = [
      'tool: exec_command {"cmd":"npm test"}',
      'tool: read_file {"path":"src/index.ts"}',
    ].join('\n');
    const events = extractToolEvents('gemini', trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'run_shell', providerToolName: 'exec_command', provider: 'gemini' }),
      expect.objectContaining({ action: 'read_file', providerToolName: 'read_file', provider: 'gemini' }),
    ]);
  });

  it('returns empty array when no recognizable tool trace is present', () => {
    expect(extractToolEvents('codex', 'plain assistant text')).toEqual([]);
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

    const events = extractToolEvents('codex', trace, 1);

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

  it('extracts tool events from Claude stream-json NDJSON output', () => {
    const trace = [
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/app.ts"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file contents"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.ts","old_string":"a","new_string":"b"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}',
      '{"type":"result","result":"Done fixing the bug.","session_id":"sess-123"}',
    ].join('\n');
    const events = extractToolEvents('claude', trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'read_file', providerToolName: 'Read', provider: 'claude' }),
      expect.objectContaining({ action: 'edit_file', providerToolName: 'Edit', provider: 'claude' }),
      expect.objectContaining({ action: 'run_shell', providerToolName: 'Bash', provider: 'claude' }),
    ]);
  });

  it('extracts Claude tool arguments correctly', () => {
    const trace = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}';
    const events = extractToolEvents('claude', trace);
    expect(events[0].arguments).toEqual({ command: 'npm test' });
    expect(events[0].summary).toBe('npm test');
  });

  it('returns empty array for Claude output with no tool_use blocks', () => {
    const trace = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}',
      '{"type":"result","result":"Hello!","session_id":"sess-123"}',
    ].join('\n');
    expect(extractToolEvents('claude', trace)).toEqual([]);
  });

  it('handles Claude stream-json with multiple tool_use blocks in one message', () => {
    const trace = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'text', text: 'Reading files...' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'b.ts' } },
        ],
      },
    });
    const events = extractToolEvents('claude', trace);
    expect(events).toHaveLength(2);
    expect(events[0].arguments).toEqual({ file_path: 'a.ts' });
    expect(events[1].arguments).toEqual({ file_path: 'b.ts' });
  });

  it('caps rawSnippet at 200 characters', () => {
    const longCmd = 'x'.repeat(300);
    const trace = `tool: exec_command {"cmd":"${longCmd}"}`;
    const events = extractToolEvents('codex', trace);
    expect(events).toHaveLength(1);
    expect(events[0].rawSnippet.length).toBeLessThanOrEqual(200);
  });

  it('preserves turnNumber when provided', () => {
    const trace = 'tool: exec_command {"cmd":"ls"}';
    const events = extractToolEvents('codex', trace, 3);
    expect(events[0].turnNumber).toBe(3);
  });

  it('maps common tool names to normalized actions', () => {
    const trace = [
      'tool: write_file {"path":"out.txt","content":"hi"}',
      'tool: edit_file {"path":"src/app.ts","old":"a","new":"b"}',
      'tool: localSearchCode {"pattern":"TODO"}',
      'tool: list_files {"path":"src"}',
    ].join('\n');
    const events = extractToolEvents('codex', trace);
    expect(events).toEqual([
      expect.objectContaining({ action: 'write_file' }),
      expect.objectContaining({ action: 'edit_file' }),
      expect.objectContaining({ action: 'search_code' }),
      expect.objectContaining({ action: 'list_files' }),
    ]);
  });
});
