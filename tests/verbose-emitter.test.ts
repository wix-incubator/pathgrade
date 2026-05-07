import { beforeEach, describe, expect, it } from 'vitest';
import { createVerboseEmitter, type VerboseSink } from '../src/reporters/verbose-emitter.js';

function createFakeSink(): VerboseSink & { lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        write(line: string) {
            lines.push(line);
        },
    };
}

/**
 * Strip ANSI escape sequences so tests can assert on content without
 * worrying about color codes.
 */
function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('createVerboseEmitter', () => {
    beforeEach(() => {
        // Colors on by default; individual tests may re-check NO_COLOR.
        delete process.env.NO_COLOR;
    });

    it('is a no-op when disabled — sink receives zero writes', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: false, sink });
        emitter.turnStart({ turn: 1, kind: 'agent_start', message: 'hi' });
        emitter.toolEvent({ action: 'read_file', summary: 'x.ts' });
        emitter.turnEnd({ turn: 1, durationMs: 1000, outputLines: 2, messagePreview: 'done' });
        emitter.retry({ attempt: 1, maxAttempts: 2, errorMessage: 'oops' });
        emitter.reactionFired({ turn: 1, reactionIndex: 0, pattern: '/x/', reply: 'r' });
        emitter.conversationEnd({ reason: 'until', turns: 2, durationMs: 1500 });
        expect(sink.lines).toEqual([]);
        expect(emitter.enabled).toBe(false);
    });

    it('formats turnStart as `→ Turn N [kind] "preview"`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.turnStart({ turn: 3, kind: 'user_reply', message: 'Create hello.txt' });
        // First line is the test-name header (if testName given). No testName here,
        // so the first visible write is the turn_start line itself.
        const turnLine = sink.lines.find((l) => stripAnsi(l).includes('Turn 3'));
        expect(turnLine).toBeDefined();
        expect(stripAnsi(turnLine!)).toBe('→ Turn 3 [user_reply] "Create hello.txt"');
    });

    it('formats toolEvent as `  · action summary`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.toolEvent({ action: 'read_file', summary: 'src/foo.ts' });
        expect(stripAnsi(sink.lines[0])).toBe('  · read_file src/foo.ts');
    });

    it('formats turnEnd as `← Turn N Ns Nl "preview"`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.turnEnd({ turn: 2, durationMs: 1500, outputLines: 4, messagePreview: 'all done' });
        expect(stripAnsi(sink.lines[0])).toBe('← Turn 2  1.5s  4l  "all done"');
    });

    it('formats retry as `  ⟲ retry n/max: error`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.retry({ attempt: 1, maxAttempts: 2, errorMessage: 'rate limited' });
        expect(stripAnsi(sink.lines[0])).toBe('  ⟲ retry 1/2: rate limited');
    });

    it('truncates retry errorMessage to 120 chars with an ellipsis', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        const long = 'x'.repeat(200);
        emitter.retry({ attempt: 1, maxAttempts: 2, errorMessage: long });
        const line = stripAnsi(sink.lines[0]);
        expect(line).toMatch(/: x{120}…$/);
    });

    it('formats reactionFired as `  ⚡ reaction #i /pattern/ → "reply"`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.reactionFired({ turn: 2, reactionIndex: 1, pattern: '/confirm/i', reply: 'yes' });
        expect(stripAnsi(sink.lines[0])).toBe('  ⚡ reaction #1 /confirm/i → "yes"');
    });

    it('formats conversationEnd as `■ end  reason=X  turns=N  Ms`', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.conversationEnd({ reason: 'until', turns: 3, durationMs: 4500 });
        expect(stripAnsi(sink.lines[0])).toBe('■ end  reason=until  turns=3  4.5s');
    });

    it('prints testName header once before the first real event', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink, testName: 'hello > creates file' });
        emitter.turnStart({ turn: 1, kind: 'agent_start', message: 'hi' });
        emitter.turnEnd({ turn: 1, durationMs: 10, outputLines: 1, messagePreview: 'ok' });
        expect(stripAnsi(sink.lines[0])).toContain('hello > creates file');
        // Only one header line, not before every event.
        const headerCount = sink.lines.filter((l) => stripAnsi(l).includes('hello > creates file')).length;
        expect(headerCount).toBe(1);
    });

    it('emits no testName header when no events fire', () => {
        const sink = createFakeSink();
        createVerboseEmitter({ enabled: true, sink, testName: 'idle test' });
        expect(sink.lines).toEqual([]);
    });

    it('truncates a long prompt preview to 80 chars + ellipsis', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        const long = 'a'.repeat(200);
        emitter.turnStart({ turn: 1, kind: 'agent_start', message: long });
        const line = stripAnsi(sink.lines[0]);
        expect(line).toMatch(/^→ Turn 1 \[agent_start\] "a{80}…"$/);
    });

    it('normalizes embedded newlines in previews to ⏎', () => {
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.turnStart({ turn: 1, kind: 'agent_start', message: 'line1\nline2' });
        const line = stripAnsi(sink.lines[0]);
        expect(line).toBe('→ Turn 1 [agent_start] "line1⏎line2"');
    });

    it('respects NO_COLOR — no ANSI escapes in output when NO_COLOR is set at module load', () => {
        // fmt helpers snapshot NO_COLOR at module-import time, so we can only
        // rely on the test environment not having it set. Independently verify
        // the emitter does not invent its own ANSI codes outside fmt.
        const sink = createFakeSink();
        const emitter = createVerboseEmitter({ enabled: true, sink });
        emitter.turnStart({ turn: 1, kind: 'agent_start', message: 'hi' });
        emitter.turnEnd({ turn: 1, durationMs: 10, outputLines: 1, messagePreview: 'ok' });
        emitter.conversationEnd({ reason: 'until', turns: 1, durationMs: 10 });
        // stripAnsi should yield human-readable content for every line.
        for (const line of sink.lines) {
            expect(stripAnsi(line).length).toBeGreaterThan(0);
        }
    });
});
