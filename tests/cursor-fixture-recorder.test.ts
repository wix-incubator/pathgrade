import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CURSOR_FIXTURE_HEADER_PREFIX,
  CURSOR_PINNED_CLI_VERSION,
  CURSOR_FIXTURES_DIR,
  checkCursorCliDrift,
  formatFixtureHeader,
  readFixtureCliVersion,
} from '../scripts/record-cursor-fixtures.js';

describe('cursor fixture recorder helpers', () => {
  describe('formatFixtureHeader', () => {
    it('prefixes the version with the expected comment marker and ends with a newline', () => {
      const header = formatFixtureHeader('2026.04.17-787b533');
      expect(header.startsWith(CURSOR_FIXTURE_HEADER_PREFIX)).toBe(true);
      expect(header).toContain('2026.04.17-787b533');
      expect(header.endsWith('\n')).toBe(true);
    });
  });

  describe('readFixtureCliVersion', () => {
    let tmp: string;
    beforeEach(async () => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-fix-ver-'));
    });
    afterEach(async () => {
      await fs.remove(tmp);
    });

    it('returns the pinned version from a fixture with a proper header', async () => {
      const file = path.join(tmp, 'x.ndjson');
      await fs.writeFile(file, `${CURSOR_FIXTURE_HEADER_PREFIX} 2026.04.17-787b533\n{"type":"result"}\n`);
      expect(readFixtureCliVersion(file)).toBe('2026.04.17-787b533');
    });

    it('returns undefined when the fixture has no header', async () => {
      const file = path.join(tmp, 'x.ndjson');
      await fs.writeFile(file, '{"type":"result"}\n');
      expect(readFixtureCliVersion(file)).toBeUndefined();
    });
  });

  describe('checkCursorCliDrift', () => {
    it('returns status: match when installed CLI matches pinned version', () => {
      const result = checkCursorCliDrift({
        pinnedVersion: '2026.04.17-787b533',
        getInstalledVersion: () => '2026.04.17-787b533',
      });
      expect(result.status).toBe('match');
      expect(result.installed).toBe('2026.04.17-787b533');
      expect(result.pinned).toBe('2026.04.17-787b533');
    });

    it('returns status: mismatch with a warning message when versions differ', () => {
      const result = checkCursorCliDrift({
        pinnedVersion: '2026.04.17-787b533',
        getInstalledVersion: () => '2026.05.01-abc',
      });
      expect(result.status).toBe('mismatch');
      expect(result.installed).toBe('2026.05.01-abc');
      expect(result.message).toContain('record-cursor-fixtures');
    });

    it('returns status: skipped when the installer reports "not installed" (returns undefined)', () => {
      const result = checkCursorCliDrift({
        pinnedVersion: '2026.04.17-787b533',
        getInstalledVersion: () => undefined,
      });
      expect(result.status).toBe('skipped');
      expect(result.installed).toBeUndefined();
      expect(result.message).toContain('not installed');
    });

    it('returns status: skipped (no throw) when the installer itself throws (ENOENT)', () => {
      const result = checkCursorCliDrift({
        pinnedVersion: '2026.04.17-787b533',
        getInstalledVersion: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      });
      expect(result.status).toBe('skipped');
      expect(result.message).toContain('not installed');
    });
  });

  describe('fixture headers', () => {
    it('CURSOR_PINNED_CLI_VERSION matches the PRD-pinned CLI version', () => {
      expect(CURSOR_PINNED_CLI_VERSION).toBe('2026.04.17-787b533');
    });

    it('every committed NDJSON fixture in the cursor fixtures dir carries a pinned-version header', async () => {
      const entries = await fs.readdir(CURSOR_FIXTURES_DIR);
      const ndjson = entries.filter((name) => name.endsWith('.ndjson'));
      expect(ndjson.length).toBeGreaterThan(0);
      for (const name of ndjson) {
        const version = readFixtureCliVersion(path.join(CURSOR_FIXTURES_DIR, name));
        expect(version, `fixture ${name} missing version header`).toBe(CURSOR_PINNED_CLI_VERSION);
      }
    });

    it('plain-text workspace-trust fixture carries a pinned-version header too', async () => {
      const file = path.join(CURSOR_FIXTURES_DIR, 'envelope-workspace-trust-block.txt');
      expect(readFixtureCliVersion(file)).toBe(CURSOR_PINNED_CLI_VERSION);
    });
  });
});
