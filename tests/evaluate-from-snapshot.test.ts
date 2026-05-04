import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { Agent, JudgeScorer, Scorer } from '../src/sdk/types.js';
import type { CommandResult, LogEntry } from '../src/types.js';
import type { ToolEvent } from '../src/tool-events.js';
import { buildRunSnapshot, evaluate, setRuntime, resetRuntime } from '../src/sdk/index.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';

const mockLLMCall = vi.fn().mockResolvedValue({
    text: '{"score": 0.8, "reasoning": "mock"}',
    provider: 'anthropic',
    model: 'test',
});

function makeAgent(overrides?: {
    workspace?: string;
    log?: LogEntry[];
    messages?: Array<{ role: 'user' | 'agent'; content: string }>;
    transcriptStr?: string;
}): Agent {
    const workspace = overrides?.workspace ?? '/fake/workspace';
    const log = overrides?.log ?? [];
    const messages = overrides?.messages ?? [
        { role: 'user' as const, content: 'Do the thing' },
        { role: 'agent' as const, content: 'Done' },
    ];
    const transcriptStr = overrides?.transcriptStr ?? '[User]\nDo the thing\n\n[Agent]\nDone';

    return {
        workspace,
        log,
        messages,
        llm: createMockLLM(),
        transcript: () => transcriptStr,
        exec: async (_cmd: string): Promise<CommandResult> => ({
            stdout: '', stderr: '', exitCode: 0,
        }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: async () => {},
    };
}

describe('evaluate.fromSnapshot', () => {
    const tempPaths: string[] = [];

    beforeEach(() => {
        setRuntime({ llm: { call: mockLLMCall } });
        mockLLMCall.mockClear();
        mockLLMCall.mockResolvedValue({
            text: '{"score": 0.8, "reasoning": "mock"}',
            provider: 'anthropic',
            model: 'test',
        });
    });

    afterEach(async () => {
        resetRuntime();
        for (const tempPath of tempPaths) {
            await fs.remove(tempPath).catch(() => {});
        }
        tempPaths.length = 0;
    });

    it('matches live deterministic scorer results for the same artifacts', async () => {
        const toolEvent: ToolEvent = {
            action: 'run_shell',
            provider: 'codex',
            providerToolName: 'exec_command',
            summary: 'npm test',
            confidence: 'high',
            rawSnippet: 'npm test',
        };
        const log: LogEntry[] = [
            { type: 'agent_start', timestamp: '2026-04-07T12:00:00.000Z', instruction: 'Do the thing' },
            { type: 'tool_event', timestamp: '2026-04-07T12:00:01.000Z', tool_event: toolEvent },
            { type: 'agent_result', timestamp: '2026-04-07T12:00:02.000Z', assistant_message: 'Done' },
        ];
        const messages = [
            { role: 'user' as const, content: 'Do the thing' },
            { role: 'agent' as const, content: 'Done' },
        ];
        const agent = makeAgent({
            log,
            messages,
            transcriptStr: '[User]\nDo the thing\n\n[Agent]\nDone',
        });

        const scorers: Scorer[] = [
            {
                type: 'check',
                name: 'has transcript',
                weight: 1,
                fn: (ctx) => ctx.transcript.includes('Done'),
            },
            {
                type: 'score',
                name: 'message count',
                weight: 1,
                fn: (ctx) => ctx.log.length / 3,
            },
            {
                type: 'tool_usage',
                name: 'used shell',
                weight: 1,
                expectations: [{ action: 'run_shell', min: 1 }],
            },
        ];

        const live = await evaluate(agent, scorers);

        const snapshotDir = path.join(os.tmpdir(), `pg-from-snapshot-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(snapshotDir);
        await fs.ensureDir(snapshotDir);
        const snapshotPath = path.join(snapshotDir, 'run-snapshot.json');
        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages,
            log,
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 25 }],
                stepResults: [],
            },
            workspace: snapshotDir,
        }), { spaces: 2 });

        const replayed = await evaluate.fromSnapshot(snapshotPath, scorers);

        expect(replayed.score).toBe(live.score);
        expect(replayed.scorers).toEqual(live.scorers);
    });

    it('uses the reconstructed transcript for judge scorers', async () => {
        const snapshotDir = path.join(os.tmpdir(), `pg-from-snapshot-judge-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(snapshotDir);
        await fs.ensureDir(snapshotDir);
        const snapshotPath = path.join(snapshotDir, 'run-snapshot.json');

        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages: [
                { role: 'user', content: 'Fix bugs' },
                { role: 'agent', content: 'Fixed all bugs' },
            ],
            log: [],
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }],
                stepResults: [],
            },
            workspace: snapshotDir,
        }), { spaces: 2 });

        const scorer: JudgeScorer = {
            type: 'judge',
            name: 'review',
            weight: 1,
            rubric: 'Did the agent fix the bugs?',
        };

        await evaluate.fromSnapshot(snapshotPath, [scorer]);

        expect(mockLLMCall).toHaveBeenCalledOnce();
        const prompt = mockLLMCall.mock.calls[0][0];
        expect(prompt).toContain('[User]\nFix bugs');
        expect(prompt).toContain('[Agent]\nFixed all bugs');
    });

    it('exposes session artifacts for live evaluate() scorers', async () => {
        const workspaceDir = path.join(os.tmpdir(), `pg-live-artifacts-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(workspaceDir);
        await fs.ensureDir(path.join(workspaceDir, 'artifacts', 'discovery'));

        const reportPath = path.join(workspaceDir, 'artifacts', 'discovery', 'ingest-report-live.md');
        await fs.writeFile(reportPath, 'live-report');

        const agent = makeAgent({
            workspace: workspaceDir,
            log: [
                {
                    type: 'tool_event',
                    timestamp: '2026-04-15T06:02:00.000Z',
                    tool_event: {
                        action: 'write_file',
                        provider: 'codex',
                        providerToolName: 'write_file',
                        arguments: { path: reportPath },
                        summary: `write_file ${reportPath}`,
                        confidence: 'high',
                        rawSnippet: '',
                    },
                },
            ],
        });

        const result = await evaluate(agent, [{
            type: 'check',
            name: 'live artifact helper works',
            weight: 1,
            fn: async (ctx) => {
                const listed = ctx.artifacts.list();
                const latest = await ctx.artifacts.latest();
                return listed[0] === 'artifacts/discovery/ingest-report-live.md'
                    && latest?.content === 'live-report';
            },
        }]);

        expect(result.score).toBe(1);
    });

    it('runs workspace commands lazily and throws a typed error when the workspace is missing', async () => {
        const workspaceDir = path.join(os.tmpdir(), `pg-from-snapshot-workspace-${Math.random().toString(36).slice(2)}`);
        const snapshotDir = path.join(os.tmpdir(), `pg-from-snapshot-workspace-file-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(workspaceDir, snapshotDir);
        await fs.ensureDir(workspaceDir);
        await fs.ensureDir(snapshotDir);
        await fs.writeFile(path.join(workspaceDir, 'artifact.txt'), 'snapshot-data');

        const snapshotPath = path.join(snapshotDir, 'run-snapshot.json');
        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages: [{ role: 'user', content: 'Check file' }],
            log: [],
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }],
                stepResults: [],
            },
            workspace: workspaceDir,
        }), { spaces: 2 });

        const passes = await evaluate.fromSnapshot(snapshotPath, [{
            type: 'check',
            name: 'artifact exists',
            weight: 1,
            fn: async (ctx) => (await ctx.runCommand('cat artifact.txt')).stdout.trim() === 'snapshot-data',
        }]);
        expect(passes.score).toBe(1);

        await fs.remove(workspaceDir);

        const missingWorkspace = await evaluate.fromSnapshot(snapshotPath, [{
            type: 'check',
            name: 'artifact missing',
            weight: 1,
            fn: async (ctx) => {
                await ctx.runCommand('cat artifact.txt');
                return true;
            },
        }]);

        expect(missingWorkspace.scorers).toMatchObject([{
            name: 'artifact missing',
            status: 'error',
        }]);

        await expect(evaluate.fromSnapshot(snapshotPath, [{
            type: 'check',
            name: 'artifact missing',
            weight: 1,
            fn: async (ctx) => {
                await ctx.runCommand('cat artifact.txt');
                return true;
            },
        }], { onScorerError: 'fail' })).rejects.toMatchObject({ name: 'EvalScorerError' });
    });

    it('exposes session artifacts for scorers without shelling out', async () => {
        const workspaceDir = path.join(os.tmpdir(), `pg-from-snapshot-artifacts-${Math.random().toString(36).slice(2)}`);
        const snapshotDir = path.join(os.tmpdir(), `pg-from-snapshot-artifacts-file-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(workspaceDir, snapshotDir);
        await fs.ensureDir(path.join(workspaceDir, 'artifacts', 'discovery'));
        await fs.ensureDir(snapshotDir);

        const competitorPath = path.join(workspaceDir, 'artifacts', 'discovery', 'competitor.md');
        const reportPath = path.join(workspaceDir, 'artifacts', 'discovery', 'ingest-report-20260415.md');
        await fs.writeFile(competitorPath, 'Shopify launched native prepaid subscriptions');
        await fs.writeFile(reportPath, '# Validation\napplied');

        const snapshotPath = path.join(snapshotDir, 'run-snapshot.json');
        await fs.writeJSON(snapshotPath, buildRunSnapshot({
            agent: 'codex',
            messages: [{ role: 'user', content: 'Check artifacts' }],
            log: [
                {
                    type: 'tool_event',
                    timestamp: '2026-04-15T06:00:00.000Z',
                    tool_event: {
                        action: 'edit_file',
                        provider: 'codex',
                        providerToolName: 'edit_file',
                        arguments: { path: competitorPath },
                        summary: `edit_file ${competitorPath}`,
                        confidence: 'high',
                        rawSnippet: '',
                    },
                },
                {
                    type: 'tool_event',
                    timestamp: '2026-04-15T06:01:00.000Z',
                    tool_event: {
                        action: 'write_file',
                        provider: 'codex',
                        providerToolName: 'write_file',
                        arguments: { path: reportPath },
                        summary: `write_file ${reportPath}`,
                        confidence: 'high',
                        rawSnippet: '',
                    },
                },
            ],
            conversationResult: {
                turns: 1,
                completionReason: 'until',
                turnTimings: [{ turn: 1, durationMs: 10 }],
                stepResults: [],
            },
            workspace: workspaceDir,
        }), { spaces: 2 });

        const result = await evaluate.fromSnapshot(snapshotPath, [{
            type: 'check',
            name: 'artifact helper works',
            weight: 1,
            fn: async (ctx) => {
                const listed = ctx.artifacts.list();
                const competitor = await ctx.artifacts.read('artifacts/discovery/competitor.md');
                const latest = await ctx.artifacts.latest({ pattern: /ingest-report-/ });

                return (
                    listed.includes('artifacts/discovery/competitor.md') &&
                    listed.includes('artifacts/discovery/ingest-report-20260415.md') &&
                    competitor.includes('Shopify') &&
                    latest?.path === 'artifacts/discovery/ingest-report-20260415.md' &&
                    latest.content.includes('applied')
                );
            },
        }]);

        expect(result.score).toBe(1);
    });

    it('throws typed errors for malformed snapshots and unsupported future versions', async () => {
        const malformedDir = path.join(os.tmpdir(), `pg-from-snapshot-malformed-${Math.random().toString(36).slice(2)}`);
        const futureDir = path.join(os.tmpdir(), `pg-from-snapshot-future-${Math.random().toString(36).slice(2)}`);
        tempPaths.push(malformedDir, futureDir);
        await fs.ensureDir(malformedDir);
        await fs.ensureDir(futureDir);

        const malformedPath = path.join(malformedDir, 'run-snapshot.json');
        const futurePath = path.join(futureDir, 'run-snapshot.json');
        await fs.writeFile(malformedPath, '{"version":1,"messages":[');
        await fs.writeJSON(futurePath, {
            version: 999,
            messages: [],
            log: [],
            toolEvents: [],
            conversationResult: { turns: 0, completionReason: 'until', turnTimings: [] },
            workspace: null,
        });

        await expect(evaluate.fromSnapshot(malformedPath, [])).rejects.toMatchObject({ name: 'SnapshotParseError' });
        await expect(evaluate.fromSnapshot(futurePath, [])).rejects.toMatchObject({ name: 'SnapshotVersionError' });
    });
});
