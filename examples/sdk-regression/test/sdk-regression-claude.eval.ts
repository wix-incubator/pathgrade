/**
 * SDK regression (Claude) — runs the full regression scenario against Claude.
 * See test/shared.ts for the feature matrix.
 *
 * Also pins the four PR-review defect repairs landed in the
 * `claude-sdk-agent-driver` branch's fix-while-rebasing patch:
 *   F1  workspace runtime env spreads wholesale onto Options.env
 *   F1b driver-owned CLAUDE_CONFIG_DIR overrides any user-supplied collision
 *   F2  ClaudeAgent.run() falls through to BaseAgent's diagnostic
 *   F3  slash-command `use_skill` synthesizes once across multi-turn runs
 *   F4  ask-bus rejection returns an error AgentTurnResult with partial trace
 *   F5  `runConversation` projects the failed turn before propagating
 *   F6  resumed sessions point at the rejected turn's session_id
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type {
    Options as SdkOptions,
    Query as SdkQuery,
    SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PathgradeMeta } from '@wix/pathgrade';
import { createAgent, createAskBus, getAgentCapabilities } from '@wix/pathgrade';
import { HOOK_TIMEOUT_MS, runRegression, type RegressionRun } from './shared.js';
// Internal driver class — imported via relative path because `run()` and the
// driver-level error contract live below the public Agent surface that
// `createAgent` exposes. The eval covers them so a regression at those layers
// is caught by the same suite users run after SDK changes.
import { ClaudeAgent } from '../../../src/agents/claude.js';
import { runConversation } from '../../../src/sdk/converse.js';
import type { AgentTurnResult, LogEntry } from '../../../src/types.js';
import type { Message } from '../../../src/sdk/types.js';

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

    it('uses the reliable AskUser transport (no noninteractive runtime policy)', async () => {
        // Slice #004 flipped Claude's transport from 'noninteractive' →
        // 'reliable' once the live ask-user bridge replaced the prompt-prepend
        // workaround. `planRuntimePolicies('claude')` therefore returns `[]`
        // and the legacy `noninteractive-user-question` policy must never
        // appear in the log. Any AskUserQuestion that fires must have been
        // resolved by the bridge (source: 'reaction' or 'fallback'), never
        // the projector's pre-bridge `'unknown'` placeholder.
        const { snapshot } = await getRun();
        expect(getAgentCapabilities(AGENT).interactiveQuestionTransport).toBe('reliable');
        expect(
            snapshot.log.some((e) =>
                e.runtime_policies_applied?.some((p) => p.id === 'noninteractive-user-question'),
            ),
        ).toBe(false);
        const askUserEvents = snapshot.toolEvents.filter((e) => e.action === 'ask_user');
        for (const ev of askUserEvents) {
            const args = ev.arguments as Record<string, unknown>;
            expect(args.answerSource).not.toBe('unknown');
        }
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

// =============================================================================
// PR-review defect repair regression — fix-while-rebasing patch on the
// claude-sdk-agent-driver branch (PRD: 2026-05-06).
//
// These exercises focus tightly on the four regressions the squashed migration
// would otherwise have shipped. F1/F1b/F3 drive a real Claude run because the
// observable surface lives at the Bash/`printenv` tool layer the agent invokes
// from inside its sandbox. F2 and F4–F6 exercise the driver directly: their
// boundaries (the override of `run()`, the ask-bus rejection contract) sit
// below the `Agent` interface that `createAgent` exposes, so the driver class
// is the smallest scope where the behavior actually lives.
// =============================================================================

describe('claude-sdk-agent-driver — PR-review defect repairs', () => {
    it('F1+F1b: createAgent({ env }) reaches the SDK subprocess and CLAUDE_CONFIG_DIR is overridden', async () => {
        // The pre-fix driver plucked only ANTHROPIC_* keys out of the workspace
        // env, dropping documented `createAgent({ env })` injection AND
        // sandbox HOME/TMPDIR. The fix spreads the workspace runtime env
        // wholesale and layers driver-owned CLAUDE_CONFIG_DIR on top so the
        // hermetic invariant survives. We probe both at once: a non-auth
        // `PATHGRADE_PROBE_VALUE` must reach the agent's Bash subprocess, AND
        // a deliberately-conflicting CLAUDE_CONFIG_DIR must be overridden by
        // the driver-owned per-trial scratch path.
        const probeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-probe-env-'));
        try {
            const agent = await createAgent({
                agent: 'claude',
                timeout: 120,
                workspace: probeWorkspace,
                env: {
                    PATHGRADE_PROBE_VALUE: 'env-spread-works-2026',
                    CLAUDE_CONFIG_DIR: '/should/be/overridden',
                },
            });
            try {
                const reply = await agent.prompt(
                    'Run a single shell command: `printenv PATHGRADE_PROBE_VALUE; printenv CLAUDE_CONFIG_DIR`. ' +
                    'Then in your reply, quote the two values verbatim, one per line, with no extra commentary.',
                );

                // F1 — wholesale env spread carries the user-supplied probe.
                expect(reply).toContain('env-spread-works-2026');
                // F1b — driver-owned CLAUDE_CONFIG_DIR per-trial path wins on
                // the collision; the user-supplied value never reaches the
                // subprocess.
                expect(reply).toContain('.pathgrade-claude-config');
                expect(reply).not.toContain('/should/be/overridden');
            } finally {
                await agent.dispose();
            }
        } finally {
            fs.rmSync(probeWorkspace, { recursive: true, force: true });
        }
    }, HOOK_TIMEOUT_MS);

    it('F2: ClaudeAgent.run() throws BaseAgent\'s "must implement createSession() or run()" diagnostic', () => {
        // The pre-fix driver overrode `run()` to call `createSession` with no
        // session options; the bridge then threw "askBus required" — a
        // misleading error suggesting the caller could supply a missing
        // argument. The fix deletes the override so `BaseAgent.run()`'s honest
        // diagnostic surfaces instead. `BaseAgent.run` is not declared async,
        // so the throw is synchronous — wrap in a thunk for `toThrow`.
        const agent = new ClaudeAgent();
        expect(() =>
            agent.run('hi', '/tmp/workspace', async () => ({
                stdout: '', stderr: '', exitCode: 0,
            })),
        ).toThrow('Agent must implement createSession() or run()');
    });

    it('F3: a multi-turn slash-command conversation synthesizes use_skill exactly once', async () => {
        // The pre-fix driver cached the conversation's first user message and
        // passed it to the projector on every turn. Combined with the SDK
        // emitting a fresh `init` system message (carrying `skills`) per
        // `query()` call — each turn spawns a new subprocess — the projector
        // re-fired `prependSlashCommandSkillEvent` on turn 2+ for the same
        // skill activation. The fix gates the projector input by turn number
        // so synthesis matches the legacy NDJSON parser's semantic: once on
        // turn 1, never thereafter. We stage a project skill at
        // `<cwd>/.claude/skills/<name>/SKILL.md` (the same shape verified by
        // the smoke test), open with `/<name>`, and force a second turn with
        // a catch-all reaction. The snapshot must contain exactly one
        // `use_skill` event for the staged skill.
        const skillName = 'pathgrade-regression-skill';
        const probeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-probe-skill-'));
        const skillDir = path.join(probeWorkspace, '.claude', 'skills', skillName);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            [
                '---',
                `name: ${skillName}`,
                'description: Regression-only skill used to pin slash-command synthesis behavior.',
                '---',
                '',
                'When invoked, simply acknowledge in one short sentence and continue normally.',
                '',
            ].join('\n'),
        );

        try {
            const agent = await createAgent({
                agent: 'claude',
                timeout: 240,
                workspace: probeWorkspace,
            });
            try {
                const result = await agent.runConversation({
                    firstMessage: `/${skillName} please reply with the literal word ack and stop.`,
                    maxTurns: 2,
                    reactions: [
                        // Catch-all that always fires so a second model turn
                        // runs — the second turn is what pins the gating fix.
                        { when: /.*/, reply: 'thanks, please reply with the literal word done and stop.' },
                    ],
                });

                // The conversation reaches at least 2 turns (maxTurns=2 → both
                // turns run). The fix is observable on turn 2: zero new
                // `use_skill` synthesis. We assert the global count via the
                // toolEvents log.
                expect(result.turns).toBeGreaterThanOrEqual(2);

                const useSkillEvents = agent.log
                    .filter((e) => e.type === 'tool_event')
                    .map((e) => e.tool_event!)
                    .filter((te) => te.action === 'use_skill' && te.skillName === skillName);
                expect(useSkillEvents).toHaveLength(1);
            } finally {
                await agent.dispose();
            }
        } finally {
            fs.rmSync(probeWorkspace, { recursive: true, force: true });
        }
    }, HOOK_TIMEOUT_MS);

    describe('F4–F6: ask-bus rejection contract', () => {
        // The pre-fix driver threw the bridge's captured error mid-turn,
        // skipping projection and dropping five log surfaces (priorSessionId
        // for resume, toolEvents, model_agent_result, ask_batch entries, and
        // turn timings/details). The fix returns an error `AgentTurnResult`
        // carrying `exitCode = 1`, `errorSubtype = 'bus_rejection'`, the
        // bridge error message in `rawOutput`, and the projected partial
        // trace; the runConversation throw moves to AFTER
        // `pushModelAgentMessage` runs so the failure mode is observable in
        // the same shape as a successful turn.
        //
        // These cases trigger bus rejection deterministically by driving the
        // ClaudeAgent driver directly with a fake `query()` that emits an
        // `AskUserQuestion` tool_use against a bus with no subscriber and a
        // 0ms timeout. The behavior under these inputs is what users
        // experience when their reaction handler hangs or never registers.

        function makeInitMessage(sessionId: string): SDKMessage {
            return {
                type: 'system',
                subtype: 'init',
                session_id: sessionId,
                agents: [],
                apiKeySource: 'none',
                claude_code_version: '0.0.0-test',
                cwd: '/tmp/workspace',
                tools: [],
                mcp_servers: [],
                model: 'claude-opus-4-7',
                permissionMode: 'default',
                slash_commands: [],
                output_style: 'default',
                skills: [],
                plugins: [],
                uuid: 'init-uuid',
            } as unknown as SDKMessage;
        }
        function makeResultSuccess(sessionId: string, text: string): SDKMessage {
            return {
                type: 'result',
                subtype: 'success',
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                num_turns: 1,
                result: text,
                stop_reason: 'end_turn',
                total_cost_usd: 0,
                usage: {
                    input_tokens: 1, output_tokens: 1,
                    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
                },
                modelUsage: {},
                permission_denials: [],
                uuid: 'result-uuid',
                session_id: sessionId,
            } as unknown as SDKMessage;
        }

        const askInput = {
            questions: [
                { question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] },
            ],
        };

        it('F4: bus rejection returns AgentTurnResult { exitCode:1, errorSubtype:"bus_rejection" } with partial trace', async () => {
            const askToolUseId = 'toolu-ask-eval';
            const fakeQuery = (args: { prompt: string | unknown; options?: SdkOptions }): SdkQuery => {
                return (async function* () {
                    yield makeInitMessage('sess-rejected');
                    yield {
                        type: 'assistant',
                        message: {
                            content: [
                                { type: 'tool_use', id: askToolUseId, name: 'AskUserQuestion', input: askInput },
                            ],
                        },
                        parent_tool_use_id: null,
                        uuid: 'a1',
                        session_id: 'sess-rejected',
                    } as unknown as SDKMessage;
                    await args.options!.canUseTool!(
                        'AskUserQuestion',
                        askInput,
                        { signal: new AbortController().signal, suggestions: [], toolUseID: askToolUseId },
                    );
                    yield makeResultSuccess('sess-rejected', 'streamed');
                })() as unknown as SdkQuery;
            };

            const agent = new ClaudeAgent({ query: fakeQuery });
            const askBus = createAskBus({ askUserTimeoutMs: 0 });
            const session = await agent.createSession('/tmp/workspace', async () => ({
                stdout: '', stderr: '', exitCode: 0,
            }), { askBus });

            const result = await session.start({ message: 'go' });

            expect(result.exitCode).toBe(1);
            expect(result.errorSubtype).toBe('bus_rejection');
            expect(result.rawOutput).toMatch(/did not resolve within 0ms/);
            // Partial trace survives — the AskUserQuestion tool_use Claude
            // emitted before the bus rejected is on `toolEvents`, and the SDK
            // stream lives on `traceOutput`.
            const askEvent = result.toolEvents.find((e) => e.action === 'ask_user');
            expect(askEvent).toBeDefined();
            expect(result.traceOutput).toContain('sess-rejected');
        });

        it('F5: runConversation projects the failed turn (model_agent_result + ask_batch) before the throw propagates', async () => {
            // Mirrors `tests/converse.test.ts:29` at the eval layer so a
            // regression at the log-then-throw ordering breaks this suite
            // alongside the unit suite. Drives `runConversation` with a
            // synthetic `sendTurn` that returns a bus_rejection result and a
            // bus that observed a partial ask batch — the exact shape the
            // Claude driver returns under a real ask-bus rejection.
            const askBus = createAskBus({ askUserTimeoutMs: 1000 });
            const log: LogEntry[] = [];
            const messages: Message[] = [];

            const sendTurn = async (): Promise<AgentTurnResult> => {
                askBus.emit({
                    batchId: 'bp-rejected-eval',
                    turnNumber: 1,
                    source: 'claude',
                    lifecycle: 'live',
                    sourceTool: 'AskUserQuestion',
                    questions: [
                        { id: 'q1', question: 'Pick one?', options: null, isOther: false, isSecret: false },
                    ],
                });
                return {
                    rawOutput: 'ask_user batch bp-rejected-eval did not resolve within 0ms',
                    assistantMessage: '',
                    visibleAssistantMessage: '',
                    visibleAssistantMessageSource: 'assistant_message',
                    exitCode: 1,
                    errorSubtype: 'bus_rejection',
                    toolEvents: [],
                    runtimePoliciesApplied: [],
                    traceOutput: 'partial-trace',
                };
            };

            const result = await runConversation(
                { firstMessage: 'go', maxTurns: 1 },
                {
                    sendTurn,
                    hasFile: async () => false,
                    workspace: '/tmp/test',
                    messages,
                    log,
                    askBus,
                },
            );

            // The five partial-turn log surfaces fired before the throw
            // propagated — this is the observability the fix preserves.
            expect(log.find((e) => e.type === 'agent_result')).toBeDefined();
            const askBatchEntries = log.filter((e) => e.type === 'ask_batch');
            expect(askBatchEntries).toHaveLength(1);
            expect(askBatchEntries[0]).toMatchObject({
                type: 'ask_batch',
                turn_number: 1,
                batch_id: 'bp-rejected-eval',
            });
            // The runner's outer catch surfaced the constructed throw.
            expect(result.completionReason).toBe('error');
            expect(result.completionDetail).toContain('did not resolve within 0ms');
        });

        it('F6: turn 2 resumes from the rejected turn\'s session_id', async () => {
            const askToolUseId = 'toolu-resume-eval';
            let callIdx = 0;
            const captured: Array<{ resume?: string }> = [];
            const fakeQuery = (args: { prompt: string | unknown; options?: SdkOptions }): SdkQuery => {
                const idx = callIdx++;
                captured.push({ resume: args.options?.resume });
                return (async function* () {
                    if (idx === 0) {
                        yield makeInitMessage('rejected-turn-session-id');
                        yield {
                            type: 'assistant',
                            message: {
                                content: [
                                    { type: 'tool_use', id: askToolUseId, name: 'AskUserQuestion', input: askInput },
                                ],
                            },
                            parent_tool_use_id: null,
                            uuid: 'a1',
                            session_id: 'rejected-turn-session-id',
                        } as unknown as SDKMessage;
                        await args.options!.canUseTool!(
                            'AskUserQuestion',
                            askInput,
                            { signal: new AbortController().signal, suggestions: [], toolUseID: askToolUseId },
                        );
                        yield makeResultSuccess('rejected-turn-session-id', 'partial');
                    } else {
                        yield makeInitMessage('rejected-turn-session-id');
                        yield makeResultSuccess('rejected-turn-session-id', 'turn2-ok');
                    }
                })() as unknown as SdkQuery;
            };

            const agent = new ClaudeAgent({ query: fakeQuery });
            const askBus = createAskBus({ askUserTimeoutMs: 0 });
            const session = await agent.createSession('/tmp/workspace', async () => ({
                stdout: '', stderr: '', exitCode: 0,
            }), { askBus });

            const turn1 = await session.start({ message: 'go' });
            expect(turn1.errorSubtype).toBe('bus_rejection');

            await session.reply({ message: 'retry' });
            // Turn 2's SDK Options.resume points at the rejected turn's
            // session_id — the driver captured it from the projection BEFORE
            // building the error result.
            expect(captured[1].resume).toBe('rejected-turn-session-id');
        });
    });
});
