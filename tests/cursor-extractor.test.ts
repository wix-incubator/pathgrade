import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { extractCursorStreamJsonEvents } from '../src/agents/cursor.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'cursor');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

describe('extractCursorStreamJsonEvents', () => {
  it('maps readToolCall to read_file with args and cursor provider tagging', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-read.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'read_file',
      provider: 'cursor',
      providerToolName: 'readToolCall',
      confidence: 'high',
      arguments: { path: 'src/app.ts' },
    });
    expect(events[0].rawSnippet.length).toBeGreaterThan(0);
  });

  it('maps editToolCall to edit_file', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-edit.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'edit_file',
      providerToolName: 'editToolCall',
      arguments: { path: 'src/app.ts', old: 'foo', new: 'bar' },
    });
  });

  it('maps globToolCall to list_files', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-glob.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'list_files',
      providerToolName: 'globToolCall',
    });
  });

  it('maps grepToolCall to search_code', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-grep.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'search_code',
      providerToolName: 'grepToolCall',
    });
  });

  it('maps shellToolCall to run_shell', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-shell.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'run_shell',
      providerToolName: 'shellToolCall',
      arguments: { command: 'npm test' },
    });
    expect(events[0].summary).toContain('npm test');
  });

  it('maps webFetchToolCall to web_fetch and ignores accompanying interaction_query lines', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-webfetch.ndjson'));
    // Only the tool_call should emit an event — interaction_query is approval metadata.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'web_fetch',
      providerToolName: 'webFetchToolCall',
    });
  });

  it('maps updateTodosToolCall to update_todos', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-update-todos.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'update_todos',
      providerToolName: 'updateTodosToolCall',
    });
  });

  it('emits ordered events for a multi-tool transcript', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-multi.ndjson'), 2);
    expect(events.map((e) => [e.action, e.providerToolName])).toEqual([
      ['read_file', 'readToolCall'],
      ['search_code', 'grepToolCall'],
      ['edit_file', 'editToolCall'],
      ['run_shell', 'shellToolCall'],
    ]);
    // turnNumber propagates to each event
    for (const e of events) expect(e.turnNumber).toBe(2);
  });

  it('returns an empty array when the transcript has no tool_call lines', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","is_error":false,"result":"hi"}',
    ].join('\n');
    expect(extractCursorStreamJsonEvents(stream)).toEqual([]);
  });

  it('ignores tool_call lines with subtype completed (not started)', () => {
    const stream = [
      '{"type":"tool_call","subtype":"completed","readToolCall":{"args":{"path":"a.ts"}}}',
    ].join('\n');
    expect(extractCursorStreamJsonEvents(stream)).toEqual([]);
  });

  it('emits action: unknown for an unrecognized discriminant but preserves the provider tool name', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-unknown.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'unknown',
      provider: 'cursor',
      providerToolName: 'futureMetaToolCall',
    });
  });

  it('reclassifies a readToolCall on SKILL.md as use_skill via enrichSkillEvents', () => {
    const events = extractCursorStreamJsonEvents(loadFixture('tool-skill-read.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'use_skill',
      provider: 'cursor',
      skillName: 'debugging',
    });
  });

  it('uses explicit discriminant probing — not Object.keys order — so wrapper keys do not misclassify', () => {
    // `id` and `ts` are imagined future metadata wrapper keys; the PRD
    // explicitly requires the extractor to skip them in favor of an
    // explicit DISCRIMINANTS probe.
    const stream = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      id: 'tc_123',
      ts: 1700000000,
      readToolCall: { args: { path: 'src/app.ts' } },
    });
    const events = extractCursorStreamJsonEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'read_file',
      providerToolName: 'readToolCall',
    });
  });

  it('caps rawSnippet length to keep memory bounded', () => {
    const longArgs = { path: 'x'.repeat(5000) };
    const stream = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      readToolCall: { args: longArgs },
    });
    const events = extractCursorStreamJsonEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].rawSnippet.length).toBeLessThanOrEqual(200);
  });

  it('skips lines that are not valid JSON without throwing', () => {
    const stream = [
      'plain text noise',
      '{"type":"tool_call","subtype":"started","readToolCall":{"args":{"path":"a.ts"}}}',
      'more noise',
    ].join('\n');
    const events = extractCursorStreamJsonEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('read_file');
  });
});
