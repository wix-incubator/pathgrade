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

  it('returns empty array for unsupported agent (claude MVP)', () => {
    expect(extractToolEvents('claude', 'any trace text')).toEqual([]);
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
