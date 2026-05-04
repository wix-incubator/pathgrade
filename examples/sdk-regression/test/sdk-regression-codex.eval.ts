/**
 * SDK regression (Codex) — runs the full regression scenario against Codex on
 * the default app-server transport (reliable interactive questions).
 * See test/shared.ts for the feature matrix.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { PathgradeMeta } from 'pathgrade';
import { getAgentCapabilities } from 'pathgrade';
import { HOOK_TIMEOUT_MS, runRegression, type RegressionRun } from './shared.js';

export const __pathgradeMeta: PathgradeMeta = {
    extraDeps: ['src/sdk/**'],
};

const DEBUG_ROOT = path.join(__dirname, 'pathgrade-debug-codex');
const AGENT = 'codex' as const;
const TRANSPORT = 'app-server' as const;

let runPromise: Promise<RegressionRun> | null = null;
function getRun() {
    if (!runPromise) {
        runPromise = runRegression({
            agent: AGENT,
            transport: TRANSPORT,
            debugRoot: DEBUG_ROOT,
            includeAskUserReaction: true,
        });
    }
    return runPromise;
}

// Codex app-server transport calls api.openai.com directly; the CI runner
// only has a private proxy token which 401s. Skip on CI — same as cursor.
describe.skipIf(!!process.env.CI)('sdk-regression (codex)', () => {
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

    it('does NOT emit the noninteractive runtime policy (app-server transport)', async () => {
        const { snapshot } = await getRun();
        expect(getAgentCapabilities(AGENT, TRANSPORT).interactiveQuestionTransport).toBe('reliable');
        expect(
            snapshot.log.some((e) =>
                e.runtime_policies_applied?.some((p) => p.id === 'noninteractive-user-question'),
            ),
        ).toBe(false);
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
