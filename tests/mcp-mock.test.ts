import { describe, it, expect } from 'vitest';
import { mockMcpServer } from '../src/core/mcp-mock';

describe('mockMcpServer', () => {
  it('returns a MockMcpServerDescriptor with __type tag', () => {
    const result = mockMcpServer({
      name: 'weather-api',
      tools: [{ name: 'get_weather', response: { temp: 72 } }],
    });

    expect(result.__type).toBe('mock_mcp_server');
    expect(result.config.name).toBe('weather-api');
    expect(result.config.tools).toHaveLength(1);
    expect(result.config.tools[0].name).toBe('get_weather');
    expect(result.config.tools[0].response).toEqual({ temp: 72 });
  });

  it('preserves optional fields', () => {
    const result = mockMcpServer({
      name: 'db',
      tools: [{
        name: 'query',
        description: 'Run a query',
        when: 'SELECT',
        inputSchema: { type: 'object', properties: { sql: { type: 'string' } } },
        response: [{ id: 1 }],
      }],
    });

    expect(result.config.tools[0].description).toBe('Run a query');
    expect(result.config.tools[0].when).toBe('SELECT');
    expect(result.config.tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { sql: { type: 'string' } },
    });
  });

  it('validates when patterns as regex at creation time', () => {
    expect(() => mockMcpServer({
      name: 'bad',
      tools: [{ name: 't', when: '(unclosed', response: 'x' }],
    })).toThrow(/regex/i);
  });

  it('throws if tools array is empty', () => {
    expect(() => mockMcpServer({ name: 'empty', tools: [] })).toThrow(/tool/i);
  });

  it('throws if name is empty', () => {
    expect(() => mockMcpServer({ name: '', tools: [{ name: 't', response: 'x' }] })).toThrow(/name/i);
  });

  it('throws if a tool has no name', () => {
    expect(() => mockMcpServer({
      name: 'srv',
      tools: [{ name: '', response: 'x' }],
    })).toThrow(/name/i);
  });
});
