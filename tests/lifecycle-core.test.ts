import { afterEach, describe, expect, it, vi } from 'vitest';
import { lifecycleCore } from '../src/sdk/lifecycle.js';
import { runWithCaseContext } from '../src/sdk/case-context.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';
import type { Agent, RecordedEvalResult } from '../src/sdk/types.js';

afterEach(() => {
    lifecycleCore.reset();
});

function fakeResult(score: number): RecordedEvalResult {
    return {
        score,
        scorers: [{ name: 'test', type: 'check', score, weight: 1 }],
    };
}

function fakeAgent(): Agent & { dispose: ReturnType<typeof vi.fn> } {
    return {
        workspace: '/fake',
        log: [],
        messages: [],
        llm: createMockLLM(),
        transcript: () => '',
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: vi.fn().mockResolvedValue(undefined),
    };
}

describe('lifecycle core', () => {
    it('flushes evaluated results only for the owning runner case and disposes that case agent', async () => {
        const agent = fakeAgent();

        runWithCaseContext({
            caseId: 'case-a',
            caseName: 'case a',
            filePath: '/evals/case.eval.ts',
            scope: 'runner-case',
        }, () => {
            lifecycleCore.registerAgent(agent);
            lifecycleCore.recordResult(fakeResult(0.8), agent);
            lifecycleCore.recordResult(fakeResult(0.6), agent);
        });

        expect(await lifecycleCore.flushCase({ caseId: 'case-b' })).toEqual([]);
        expect(agent.dispose).not.toHaveBeenCalled();

        const flushed = await lifecycleCore.flushCase({ caseId: 'case-a' });
        expect(flushed).toHaveLength(2);
        expect(flushed.map((entry) => entry.score)).toEqual([0.8, 0.6]);
        expect(flushed[0].diagnostics).toMatchObject({ score: 0.8, scorers: [{ name: 'test' }] });
        expect(agent.dispose).toHaveBeenCalledOnce();

        expect(await lifecycleCore.flushCase({ caseId: 'case-a' })).toEqual([]);
    });

    it('synthesizes no-evaluate metadata only for case-owned agents with log activity', async () => {
        const agent = fakeAgent();
        agent.log.push(
            { type: 'agent_start', timestamp: '2026-04-08T12:00:00.000Z', instruction: 'Do the thing' },
            { type: 'command', timestamp: '2026-04-08T12:00:01.000Z', command: 'mkdir -p /tmp', stdout: '', stderr: '', exitCode: 0 },
            { type: 'agent_result', timestamp: '2026-04-08T12:00:02.000Z', assistant_message: 'Done' },
        );
        agent.llm.addTokens!(100, 20);

        runWithCaseContext({
            caseId: 'case-with-logs',
            caseName: 'case with logs',
            filePath: '/evals/no-evaluate.eval.ts',
            scope: 'runner-case',
        }, () => lifecycleCore.registerAgent(agent));

        const flushed = await lifecycleCore.flushCase({ caseId: 'case-with-logs' });
        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toMatchObject({
            score: 1,
            scorers: [],
            trial: {
                reward: 1,
                scorer_results: [],
                duration_ms: 0,
                n_commands: 1,
                input_tokens: 100,
                output_tokens: 20,
            },
            diagnostics: { score: 1 },
        });
        expect(flushed[0].trial!.session_log).toHaveLength(3);

        const emptyAgent = fakeAgent();
        runWithCaseContext({
            caseId: 'case-without-logs',
            caseName: 'case without logs',
            filePath: '/evals/no-evaluate.eval.ts',
            scope: 'runner-case',
        }, () => lifecycleCore.registerAgent(emptyAgent));

        expect(await lifecycleCore.flushCase({ caseId: 'case-without-logs' })).toEqual([]);
    });

    it('keeps shared agents alive and flushes evaluated results to the emission case only', async () => {
        const shared = fakeAgent();
        runWithCaseContext({
            caseId: 'suite-shared',
            caseName: 'shared suite',
            filePath: '/evals/shared.eval.ts',
            scope: 'runner-suite-shared',
        }, () => lifecycleCore.registerAgent(shared));

        runWithCaseContext({
            caseId: 'case-a',
            caseName: 'case a',
            filePath: '/evals/shared.eval.ts',
            scope: 'runner-case',
        }, () => lifecycleCore.recordResult(fakeResult(0.7), shared));

        expect(await lifecycleCore.flushCase({ caseId: 'case-b' })).toEqual([]);
        expect(shared.dispose).not.toHaveBeenCalled();

        const caseA = await lifecycleCore.flushCase({ caseId: 'case-a' });
        expect(caseA.map((entry) => entry.score)).toEqual([0.7]);
        expect(shared.dispose).not.toHaveBeenCalled();

        expect(await lifecycleCore.flushCase({ caseId: 'case-a' })).toEqual([]);
    });

    it('releases manual agents on dispose without leaking into later runner cases', async () => {
        const manual = fakeAgent();
        lifecycleCore.registerAgent(manual);
        lifecycleCore.recordResult(fakeResult(0.4), manual);

        lifecycleCore.releaseAgent(manual);
        lifecycleCore.releaseAgent(manual);

        expect(await lifecycleCore.flushCase({ caseId: 'later-case' })).toEqual([]);
        expect(manual.dispose).not.toHaveBeenCalled();
    });

    it('retains disposed runner-case metadata until the owning case flush', async () => {
        const agent = fakeAgent();
        runWithCaseContext({
            caseId: 'runner-case-before-dispose',
            caseName: 'runner case before dispose',
            filePath: '/evals/runner.eval.ts',
            scope: 'runner-case',
        }, () => {
            lifecycleCore.registerAgent(agent);
            lifecycleCore.recordResult(fakeResult(0.95), agent);
        });

        lifecycleCore.releaseAgent(agent);

        const flushed = await lifecycleCore.flushCase({ caseId: 'runner-case-before-dispose' });
        expect(flushed.map((entry) => entry.score)).toEqual([0.95]);
        expect(agent.dispose).toHaveBeenCalledOnce();
    });

    it('cleans up remaining shared agents once at run cleanup', async () => {
        const shared = fakeAgent();
        runWithCaseContext({
            caseId: 'suite-shared',
            caseName: 'shared suite',
            filePath: '/evals/shared.eval.ts',
            scope: 'runner-suite-shared',
        }, () => lifecycleCore.registerAgent(shared));

        await lifecycleCore.cleanupAll();
        await lifecycleCore.cleanupAll();

        expect(shared.dispose).toHaveBeenCalledOnce();
    });
});
