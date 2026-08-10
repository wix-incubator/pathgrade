import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CalmRenderer } from '../src/standalone/ui/calm-renderer.js';
import { displayWidth, stripAnsi, truncateEnd, truncateMiddle } from '../src/standalone/ui/format.js';
import { StandaloneOutputController } from '../src/standalone/ui/output-controller.js';
import { StandaloneUiDecoder } from '../src/standalone/ui/protocol.js';
import { createStandaloneTheme } from '../src/standalone/ui/theme.js';
import type { StandaloneUiEvent } from '../src/standalone/ui/events.js';

function outputStream(columns = 80, isTTY = false): PassThrough & {
    columns: number;
    isTTY: boolean;
    getColorDepth: (env?: NodeJS.ProcessEnv) => number;
} {
    const stream = new PassThrough() as ReturnType<typeof outputStream>;
    stream.columns = columns;
    stream.isTTY = isTTY;
    stream.getColorDepth = env => env?.FORCE_COLOR === '0' ? 1 : 8;
    return stream;
}

function read(stream: PassThrough): string {
    return stream.read()?.toString() ?? '';
}

describe('standalone UI formatting', () => {
    it('truncates ANSI, emoji, and CJK content without exceeding the width', () => {
        const end = truncateEnd('\x1b[31m報告🙂-a-very-long-case\x1b[0m', 12);
        const middle = truncateMiddle('fixtures/報告🙂/authentication.eval.ts', 16);
        expect(displayWidth(end)).toBeLessThanOrEqual(12);
        expect(displayWidth(middle)).toBeLessThanOrEqual(16);
        expect(end).not.toContain('\x1b');
        expect(middle).toContain('…');
    });

    it.each([40, 80, 120])('keeps static output within %i columns', width => {
        const stream = outputStream(width);
        const renderer = new CalmRenderer({ stream, env: { FORCE_COLOR: '0' }, now: () => 2_000 });
        renderer.handle({ v: 1, type: 'run_start', files: [{ id: 'f', name: 'f' }], startedAt: 0 });
        renderer.handle({ v: 1, type: 'case_start', id: 'c', file: 'a/very/long/報告.eval.ts', name: 'rejects a very long leaked credential name', startedAt: 0 });
        renderer.handle({ v: 1, type: 'case_finish', id: 'c', file: 'a/very/long/報告.eval.ts', name: 'rejects a very long leaked credential name', state: 'passed', durationMs: 2_000, score: 1 });
        renderer.handle({ v: 1, type: 'run_finish', status: 'pass', fileCount: 1, passed: 1, failed: 0, skipped: 0, durationMs: 2_000, overallScore: 1, resultsPath: '.pathgrade/results.json' });
        const lines = read(stream).split('\n').filter(Boolean);
        expect(Math.max(...lines.map(line => displayWidth(stripAnsi(line))))).toBeLessThanOrEqual(Math.max(width, 40));
        expect(lines.join('\n')).toContain('PASS  1 file · 1 passed · 2s');
    });

    it('does not fabricate a score when evaluate was not called', () => {
        const stream = outputStream();
        const renderer = new CalmRenderer({ stream, env: { FORCE_COLOR: '0' } });
        renderer.handle({ v: 1, type: 'case_finish', id: 'c', file: 'compat.eval.ts', name: 'legacy pass', state: 'passed', durationMs: 10 });
        expect(read(stream)).not.toContain('score');
    });

    it('uses words instead of decorative status symbols outside a TTY', () => {
        const stream = outputStream();
        const renderer = new CalmRenderer({ stream, env: { FORCE_COLOR: '0' } });
        renderer.handle({ v: 1, type: 'case_finish', id: 'c', file: 'x.eval.ts', name: 'works', state: 'passed', durationMs: 10, score: 1 });
        expect(read(stream)).toMatch(/^PASS x\.eval\.ts/);
    });

    it('bounds concurrent active rows and restores the cursor', () => {
        const stream = outputStream(80, true);
        const renderer = new CalmRenderer({ stream, env: { FORCE_COLOR: '0' }, now: () => 1_000 });
        for (let index = 0; index < 7; index++) {
            renderer.handle({
                v: 1,
                type: 'case_start',
                id: String(index),
                file: `case-${index}.eval.ts`,
                name: `trial ${index}`,
                startedAt: 0,
            });
        }
        renderer.dispose();
        const output = read(stream);
        expect(output).toContain('and 1 more');
        expect(output).toContain('\x1b[?25l');
        expect(output).toContain('\x1b[?25h');
    });
});

describe('standalone UI protocol', () => {
    it('decodes split and combined NDJSON frames', () => {
        const events: StandaloneUiEvent[] = [];
        const invalid = vi.fn();
        const decoder = new StandaloneUiDecoder(event => events.push(event), invalid);
        decoder.push('{"v":1,"type":"run_error"}\n{"v":');
        decoder.push('1,"type":"run_error"}\n');
        decoder.end();
        expect(events).toHaveLength(2);
        expect(invalid).not.toHaveBeenCalled();
    });

    it.each([
        '{not json}\n',
        '{"v":2,"type":"run_error"}\n',
        '{"v":1,"type":"unknown"}\n',
    ])('rejects malformed or unsupported input without throwing', frame => {
        const invalid = vi.fn();
        const decoder = new StandaloneUiDecoder(() => {}, invalid);
        expect(() => decoder.push(frame)).not.toThrow();
        expect(invalid).toHaveBeenCalledOnce();
    });
});

describe('standalone output controller', () => {
    it('passes successful JSON reporter output through without fd3 events', () => {
        const stdout = outputStream();
        const stderr = outputStream();
        const controller = new StandaloneOutputController(
            { PATHGRADE_REPORTER_MODE: 'json', FORCE_COLOR: '0' },
            { stdout, stderr },
        );
        controller.stdout('{"status":"pass"}\n');
        controller.finish(0);
        expect(read(stdout)).toBe('{"status":"pass"}\n');
        expect(read(stderr)).toBe('');
    });

    it('falls back to raw Vitest output when the fd3 protocol is malformed', () => {
        const stdout = outputStream();
        const stderr = outputStream();
        const controller = new StandaloneOutputController(
            { PATHGRADE_REPORTER_MODE: 'cli', FORCE_COLOR: '0' },
            { stdout, stderr },
        );
        controller.stdout('raw vitest output\n');
        controller.protocol('{not json}\n');
        controller.finish(1);
        expect(read(stdout)).toBe('raw vitest output\n');
        expect(read(stderr)).toContain('rich output unavailable; using raw Vitest output');
    });
});

describe('standalone UI color controls', () => {
    it('respects NO_COLOR and FORCE_COLOR at runtime', () => {
        const stream = outputStream(80, true);
        expect(createStandaloneTheme(stream, { NO_COLOR: '1' }).green('ok')).toBe('ok');
        expect(createStandaloneTheme(stream, { FORCE_COLOR: '0' }).green('ok')).toBe('ok');
        expect(createStandaloneTheme(stream, { FORCE_COLOR: '1' }).green('ok')).toContain('\x1b[32m');
    });

    it('disables motion independently for CI, dumb terminals, and quiet mode', () => {
        const stream = outputStream(80, true);
        expect(createStandaloneTheme(stream, { CI: '1' }).interactive).toBe(false);
        expect(createStandaloneTheme(stream, { TERM: 'dumb' }).interactive).toBe(false);
        expect(createStandaloneTheme(stream, { PATHGRADE_QUIET: '1' }).interactive).toBe(false);
    });
});
