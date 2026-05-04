import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, formatDiagnostics } from '../src/reporters/diagnostics.js';
import type { LogEntry } from '../src/types.js';

describe('unified diagnostics module', () => {
    it('builds a multi-turn report with retry counts, warnings, and reactions', () => {
        const log: LogEntry[] = [
            {
                type: 'agent_result',
                timestamp: '2026-01-01T00:00:00.000Z',
                assistant_message: '[retry 1/2] rate limited',
            },
            {
                type: 'agent_result',
                timestamp: '2026-01-01T00:00:01.000Z',
                turn_number: 2,
                assistant_message: 'final answer',
            },
        ];

        const report = buildDiagnosticsReport({
            completionReason: 'timeout',
            score: 0.4,
            turnDetails: [
                { turn: 1, durationMs: 10_000, outputLines: 501, outputChars: 10_240 },
                { turn: 2, durationMs: 5_000, outputLines: 12, outputChars: 1_200 },
            ],
            reactionsFired: [
                { turn: 1, reactionIndex: 0, pattern: '/confirm/', reply: 'Confirmed' },
            ],
            scorers: [
                { name: 'artifact', type: 'check', score: 1, weight: 1, details: 'passed' },
                { name: 'judge', type: 'judge', score: 0, weight: 1, details: 'LLM unavailable', status: 'error' },
            ],
            log,
        });

        expect(report.turns).toBe(2);
        expect(report.totalDurationMs).toBe(15_000);
        expect(report.turnDetails).toEqual([
            { turn: 1, durationMs: 10_000, outputLines: 501, outputChars: 10_240, apiRetries: 0 },
            { turn: 2, durationMs: 5_000, outputLines: 12, outputChars: 1_200, apiRetries: 1 },
        ]);
        expect(report.reactionsFired).toEqual([
            { turn: 1, reactionIndex: 0, pattern: '/confirm/', reply: 'Confirmed' },
        ]);
        expect(report.recommendedTimeoutMs).toBe(215_000);
        expect(report.warnings).toEqual([
            'Turn 1: output exceeded 500 lines (501 lines)',
        ]);
        expect(report.scorers).toEqual([
            { name: 'artifact', type: 'check', score: 1, weight: 1, details: 'passed', status: 'ok' },
            { name: 'judge', type: 'judge', score: 0, weight: 1, details: 'LLM unavailable', status: 'error' },
        ]);
    });

    it('derives a single-turn report from agent_result log entries', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'noReply',
            score: 1,
            log: [
                {
                    type: 'agent_result',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    turn_number: 1,
                    duration_ms: 8_000,
                    output_lines: 3,
                    output_chars: 256,
                    assistant_message: 'one\ntwo\nthree',
                },
            ],
        });

        expect(report.turnDetails).toEqual([
            { turn: 1, durationMs: 8_000, outputLines: 3, outputChars: 256, apiRetries: 0 },
        ]);
        expect(report.recommendedTimeoutMs).toBe(38_000);
    });

    it('includes completionDetail in report when provided', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'error',
            completionDetail: 'Agent exited with code 1: Invalid API key · Fix external API key',
            score: 0,
            turnDetails: [],
            log: [],
        });

        expect(report.completionDetail).toBe('Agent exited with code 1: Invalid API key · Fix external API key');
    });

    it('renders completionDetail in verbose diagnostics when reason is error', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'error',
            completionDetail: 'Claude CLI exited with code 1: Invalid API key',
            score: 0,
            turnDetails: [],
            log: [],
        });

        const formatted = formatDiagnostics(report, { verbose: true });
        expect(formatted).toContain('Error: Claude CLI exited with code 1: Invalid API key');
    });

    it('renders completionDetail in verbose diagnostics when reason is timeout', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'timeout',
            completionDetail: 'Agent (limit: 300s) timed out (agent killed)',
            score: 0,
            turnDetails: [],
            log: [],
        });

        const formatted = formatDiagnostics(report, { verbose: true });
        expect(formatted).toContain('Error: Agent (limit: 300s) timed out (agent killed)');
    });

    it('does not render completionDetail when reason is until', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'until',
            completionDetail: 'irrelevant',
            score: 1,
            turnDetails: [
                { turn: 1, durationMs: 5_000, outputLines: 2, outputChars: 100 },
            ],
            log: [],
        });

        const formatted = formatDiagnostics(report, { verbose: true });
        expect(formatted).not.toContain('Error:');
    });

    it('formats a concise success summary', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'until',
            score: 0.9,
            turnDetails: [
                { turn: 1, durationMs: 12_000, outputLines: 4, outputChars: 240 },
                { turn: 2, durationMs: 10_000, outputLines: 2, outputChars: 120 },
            ],
            log: [],
        });

        const formatted = formatDiagnostics(report, { verbose: false });

        expect(formatted).toContain('2 turns');
        expect(formatted).toContain('22.0s');
        expect(formatted).toContain('until');
        expect(formatted).toContain('0.90');
    });

    it('formats a full diagnostics block with scorer statuses and timeout guidance', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'timeout',
            score: 0.25,
            turnDetails: [
                { turn: 1, durationMs: 20_000, outputLines: 600, outputChars: 5_000 },
            ],
            reactionsFired: [
                { turn: 1, reactionIndex: 2, pattern: '/continue/', reply: 'Continue' },
            ],
            scorers: [
                { name: 'artifact', type: 'check', score: 1, weight: 1, details: 'passed' },
                { name: 'judge', type: 'judge', score: 0, weight: 1, details: 'skipped (fail-fast)', status: 'skipped' },
            ],
            log: [],
        });

        const formatted = formatDiagnostics(report, { verbose: true, currentTimeoutMs: 10_000 });

        expect(formatted).toContain('Unified Diagnostics');
        expect(formatted).toContain('Turn 1');
        expect(formatted).toContain('api retries: 0');
        expect(formatted).toContain('[ok] artifact');
        expect(formatted).toContain('[skipped] judge');
        expect(formatted).toContain('Timeout should be increased to ~50s');
        expect(formatted).toContain('Turn 1: output exceeded 500 lines (600 lines)');
        expect(formatted).toContain('/continue/');
    });

    it('records applied runtime policies without storing rendered policy text', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'until',
            score: 1,
            log: [
                {
                    type: 'agent_result',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    turn_number: 1,
                    assistant_message: 'Approval required',
                    runtime_policies_applied: [
                        { id: 'noninteractive-user-question', version: '1' },
                    ],
                },
                {
                    type: 'agent_result',
                    timestamp: '2026-01-01T00:00:02.000Z',
                    turn_number: 2,
                    assistant_message: 'Still waiting',
                    runtime_policies_applied: [
                        { id: 'noninteractive-user-question', version: '1' },
                    ],
                },
            ],
        });

        expect(report.runtimePoliciesApplied).toEqual([
            {
                id: 'noninteractive-user-question',
                version: '1',
                turns: [1, 2],
            },
        ]);
    });

    it('surfaces blocked prompt provenance in diagnostics output', () => {
        const report = buildDiagnosticsReport({
            completionReason: 'until',
            score: 1,
            turnDetails: [
                { turn: 1, durationMs: 4_000, outputLines: 2, outputChars: 120 },
            ],
            log: [
                {
                    type: 'agent_result',
                    timestamp: '2026-01-01T00:00:00.000Z',
                    turn_number: 1,
                    assistant_message: 'Approval required',
                    assistant_message_source: 'blocked_prompt',
                    raw_assistant_message: 'I have what I need already.',
                    blocked_prompt_index: 0,
                    blocked_prompt_count: 2,
                    blocked_prompt_source_tool: 'AskUserQuestion',
                    blocked_prompt_tool_use_id: 'toolu_1',
                },
                {
                    type: 'agent_result',
                    timestamp: '2026-01-01T00:00:01.000Z',
                    turn_number: 1,
                    assistant_message: 'Second approval',
                    assistant_message_source: 'blocked_prompt',
                    synthetic_blocked_prompt: true,
                    blocked_prompt_source_turn: 1,
                    blocked_prompt_index: 1,
                    blocked_prompt_count: 2,
                    blocked_prompt_source_tool: 'AskUserQuestion',
                    blocked_prompt_tool_use_id: 'toolu_2',
                },
            ],
        });

        const formatted = formatDiagnostics(report, { verbose: true });

        expect(formatted).toContain('Blocked prompts:');
        expect(formatted).toContain('Turn 1: visible turn synthesized from AskUserQuestion prompt 1/2');
        expect(formatted).toContain('raw completion: I have what I need already.');
        expect(formatted).toContain('Replay from turn 1: AskUserQuestion prompt 2/2');
    });
});
