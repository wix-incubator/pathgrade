/**
 * SDK regression (Claude) — runs the full regression scenario against Claude.
 * See test/shared.ts for the feature matrix.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { PathgradeMeta } from '@wix/pathgrade';
import { getAgentCapabilities } from '@wix/pathgrade';
import { HOOK_TIMEOUT_MS, runRegression, type RegressionRun } from './shared.js';

export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**'],
};

const DEBUG_ROOT = path.join(__dirname, 'pathgrade-debug-claude');
const AGENT = 'claude' as const;

let runPromise: Promise<RegressionRun> | null = null;
function getRun() {
    if (!runPromise) {
        runPromise = runRegression({
            agent: AGENT,
            debugRoot: DEBUG_ROOT,
            includeAskUserReaction: true,
        });
    }
    return runPromise;
}

describe('sdk-regression (claude)', () => {
    it('completes a real bug-fix conversation with healthy live scoring', async () => {
        const { conversation, liveEval } = await getRun();
        expect(conversation.turns).toBeGreaterThanOrEqual(1);
        expect(conversation.turnTimings.length).toBe(conversation.turns);
        expect(['until', 'maxTurns', 'noReply']).toContain(conversation.completionReason);
        expect(liveEval.score).toBeGreaterThan(0);
        expect(liveEval.tokenUsage).toBeDefined();
        const names = liveEval.scorers.map((s) => s.name);
        expect(names).toEqual(expect.arrayContaining([
            'tests-pass', 'subtract-correctness', 'fix-workflow',
            'full-flow-quality', 'code-judge-with-tools',
        ]));
    }, HOOK_TIMEOUT_MS);

    it('captures a snapshot and replays it with workspace helpers', async () => {
        const { snapshot, snapshotReplay, preview } = await getRun();
        expect(snapshot.version).toBe(1);
        expect(snapshot.agent).toBe(AGENT);
        expect(snapshot.toolEvents.length).toBeGreaterThan(0);
        expect(snapshotReplay.score).toBe(1);
        expect(preview.turns.length).toBeGreaterThan(0);
    }, HOOK_TIMEOUT_MS);

    it('records the noninteractive runtime policy (Claude transport)', async () => {
        const { snapshot } = await getRun();
        expect(getAgentCapabilities(AGENT).interactiveQuestionTransport).toBe('noninteractive');
        expect(
            snapshot.log.some((e) =>
                e.runtime_policies_applied?.some((p) => p.id === 'noninteractive-user-question'),
            ),
        ).toBe(true);
    }, HOOK_TIMEOUT_MS);

    it('covers prompt(), exec(), and startChat() surfaces', async () => {
        const { promptText, promptTranscript, execStdout, chatTurns, chatHasFile } = await getRun();
        expect(promptText.length).toBeGreaterThan(0);
        expect(promptTranscript.length).toBeGreaterThan(0);
        expect(execStdout).toBe('4');
        expect(chatTurns).toBeGreaterThanOrEqual(1);
        expect(chatHasFile).toBe(true);
    }, HOOK_TIMEOUT_MS);

    it('runs standalone runScorer and runJudgePipeline against the snapshot', async () => {
        const { standaloneScorer, standaloneJudge } = await getRun();
        expect(standaloneScorer.name).toBe('standalone-check');
        expect(standaloneScorer.score).toBe(1);
        expect(standaloneJudge.name).toBe('standalone-judge');
        expect(standaloneJudge.score).toBeGreaterThan(0);
    }, HOOK_TIMEOUT_MS);
});
