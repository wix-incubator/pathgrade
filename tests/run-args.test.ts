import { describe, expect, it } from 'vitest';
import { parsePathgradeRunArgs } from '../src/commands/run-args.js';

describe('parsePathgradeRunArgs', () => {
    it('extracts the diagnostics flag from pathgrade run args', () => {
        expect(parsePathgradeRunArgs(['--diagnostics', '--grep', 'smoke'])).toEqual({
            forceDiagnostics: true,
            forceVerbose: false,
            changed: false,
            quiet: false,
            vitestArgs: ['--grep', 'smoke'],
        });
    });

    it('passes through normal vitest args unchanged', () => {
        expect(parsePathgradeRunArgs(['--reporter=dot'])).toEqual({
            forceDiagnostics: false,
            forceVerbose: false,
            changed: false,
            quiet: false,
            vitestArgs: ['--reporter=dot'],
        });
    });

    it('recognizes --changed without forwarding it to vitest', () => {
        const parsed = parsePathgradeRunArgs(['--changed']);
        expect(parsed.changed).toBe(true);
        expect(parsed.vitestArgs).toEqual([]);
    });

    it('recognizes --since=<ref> and --changed-files=<path>', () => {
        const parsed = parsePathgradeRunArgs([
            '--changed',
            '--since=HEAD~3',
            '--changed-files=/tmp/c.txt',
        ]);
        expect(parsed.changed).toBe(true);
        expect(parsed.since).toBe('HEAD~3');
        expect(parsed.changedFilesPath).toBe('/tmp/c.txt');
        expect(parsed.vitestArgs).toEqual([]);
    });

    it('recognizes --quiet', () => {
        const parsed = parsePathgradeRunArgs(['--changed', '--quiet']);
        expect(parsed.quiet).toBe(true);
        expect(parsed.vitestArgs).toEqual([]);
    });

    it('forwards args after `--` verbatim to vitest', () => {
        const parsed = parsePathgradeRunArgs([
            '--changed',
            '--',
            '--grep',
            'foo',
        ]);
        expect(parsed.changed).toBe(true);
        expect(parsed.vitestArgs).toEqual(['--grep', 'foo']);
    });

    it('warns when --since is passed without --changed', () => {
        const parsed = parsePathgradeRunArgs(['--since=HEAD~3']);
        expect(parsed.changed).toBe(false);
        expect(parsed.warnings ?? []).toContain(
            '--since has no effect without --changed; the flag is being ignored.',
        );
    });

    it('warns when --changed-files is passed without --changed', () => {
        const parsed = parsePathgradeRunArgs(['--changed-files=/tmp/c.txt']);
        expect(parsed.changed).toBe(false);
        expect(parsed.warnings ?? []).toContain(
            '--changed-files has no effect without --changed; the flag is being ignored.',
        );
    });

    it('does not warn when --changed is present with --since or --changed-files', () => {
        const parsed = parsePathgradeRunArgs([
            '--changed',
            '--since=HEAD~3',
            '--changed-files=/tmp/c.txt',
        ]);
        expect(parsed.warnings ?? []).toEqual([]);
    });

    it('extracts --verbose as forceVerbose=true and strips it', () => {
        const parsed = parsePathgradeRunArgs(['--verbose', '--grep', 'smoke']);
        expect(parsed.forceVerbose).toBe(true);
        expect(parsed.vitestArgs).toEqual(['--grep', 'smoke']);
    });

    it('extracts -v as forceVerbose=true and strips it', () => {
        const parsed = parsePathgradeRunArgs(['-v']);
        expect(parsed.forceVerbose).toBe(true);
        expect(parsed.vitestArgs).toEqual([]);
    });

    it('does not capture --verbose=<value> — forwards it to vitest', () => {
        const parsed = parsePathgradeRunArgs(['--verbose=bar']);
        expect(parsed.forceVerbose).toBe(false);
        expect(parsed.vitestArgs).toEqual(['--verbose=bar']);
    });

    it('defaults forceVerbose to false when --verbose is not passed', () => {
        const parsed = parsePathgradeRunArgs(['--grep', 'smoke']);
        expect(parsed.forceVerbose).toBe(false);
    });

    it('passes args after -- verbatim even if they look like --verbose', () => {
        const parsed = parsePathgradeRunArgs(['--', '--verbose', '-v']);
        expect(parsed.forceVerbose).toBe(false);
        expect(parsed.vitestArgs).toEqual(['--verbose', '-v']);
    });
});
