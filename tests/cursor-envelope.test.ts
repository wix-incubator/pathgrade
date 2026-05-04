import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseCursorStreamJson } from '../src/agents/cursor.js';

const FIXTURES = path.join(__dirname, 'fixtures', 'cursor');

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

describe('parseCursorStreamJson', () => {
  it('extracts session_id, resultText, and token usage from a success envelope', () => {
    const result = parseCursorStreamJson(loadFixture('envelope-success.ndjson'));
    expect(result.sessionId).toBe('sess-cursor-001');
    expect(result.isError).toBe(false);
    expect(result.resultText).toBe('Done fixing the bug.');
    expect(result.tokenUsage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect(result.interactionQueryCount).toBe(0);
  });

  it('flags is_error: true envelopes and preserves the error text in resultText', () => {
    const result = parseCursorStreamJson(loadFixture('envelope-error.ndjson'));
    expect(result.sessionId).toBe('sess-cursor-002');
    expect(result.isError).toBe(true);
    expect(result.resultText).toBe('Authentication failed: missing CURSOR_API_KEY');
  });

  it('surfaces plain-text non-JSON output (workspace-trust block) as an error with raw text', () => {
    const raw = loadFixture('envelope-workspace-trust-block.txt');
    const result = parseCursorStreamJson(raw);
    expect(result.isError).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(result.resultText).toContain('Workspace Trust Required');
    // Truncation ceiling
    expect(result.resultText.length).toBeLessThanOrEqual(2048);
    expect(result.tokenUsage).toBeUndefined();
    expect(result.interactionQueryCount).toBe(0);
  });

  it('truncates oversize plain-text error output to 2048 bytes', () => {
    const raw = 'x'.repeat(5000);
    const result = parseCursorStreamJson(raw);
    expect(result.isError).toBe(true);
    expect(result.resultText.length).toBe(2048);
  });

  it('sums cache_creation and cache_read into inputTokens (Claude convention)', () => {
    const result = parseCursorStreamJson(loadFixture('envelope-cache-usage.ndjson'));
    expect(result.tokenUsage).toEqual({
      // 10 + 500 + 2000
      inputTokens: 2510,
      outputTokens: 30,
    });
  });

  it('defaults missing usage fields to 0', () => {
    const stream = JSON.stringify({
      type: 'result',
      is_error: false,
      session_id: 'sess-x',
      result: 'ok',
      usage: {},
    });
    const result = parseCursorStreamJson(stream);
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('counts type: "interaction_query" events without emitting them as result text', () => {
    const result = parseCursorStreamJson(loadFixture('envelope-interaction-queries.ndjson'));
    expect(result.interactionQueryCount).toBe(3);
    expect(result.resultText).toBe('Fetched.');
  });

  it('propagates session_id across turns — extracts from the result event, not init', () => {
    // Simulates a case where init and result disagree; result is authoritative.
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stale-init-id' }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        session_id: 'authoritative-result-id',
        result: 'ok',
      }),
    ].join('\n');
    const result = parseCursorStreamJson(stream);
    expect(result.sessionId).toBe('authoritative-result-id');
  });

  it('returns isError + raw slice when no result event is found in JSON lines', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ].join('\n');
    const result = parseCursorStreamJson(stream);
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('"type":"system"');
  });

  it('is a pure function — no I/O, no state carried across calls', () => {
    const a = parseCursorStreamJson(loadFixture('envelope-success.ndjson'));
    const b = parseCursorStreamJson(loadFixture('envelope-success.ndjson'));
    expect(a).toEqual(b);
  });
});
