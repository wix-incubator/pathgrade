import { describe, it, expect } from 'vitest';
import { parseEnvFile } from '../src/utils/env.js';

describe('parseEnvFile', () => {
  it('parses simple KEY=VALUE pairs', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores blank lines', () => {
    const result = parseEnvFile('FOO=bar\n\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comment lines', () => {
    const result = parseEnvFile('# This is a comment\nFOO=bar\n# Another\nBAZ=qux');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles values with = signs', () => {
    const result = parseEnvFile('API_KEY=abc=def=ghi');
    expect(result).toEqual({ API_KEY: 'abc=def=ghi' });
  });

  it('strips surrounding quotes from values', () => {
    const result = parseEnvFile('FOO="bar"\nBAZ=\'qux\'');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty object for empty input', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  it('trims whitespace from keys and values', () => {
    const result = parseEnvFile('  FOO = bar  ');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips lines without = sign', () => {
    const result = parseEnvFile('INVALID_LINE\nFOO=bar');
    expect(result).toEqual({ FOO: 'bar' });
  });
});
