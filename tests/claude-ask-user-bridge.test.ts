/**
 * Tests for src/agents/claude/ask-user-bridge.ts (issue #004).
 *
 * The bridge is a pure function over `(askBus, getTurnNumber, answerStore) →
 * CanUseTool`. It replaces the placeholder `canUseTool` deny that #001 stamped
 * for `AskUserQuestion` with a live ask-bus round-trip:
 *
 *   - Non-`AskUserQuestion` tools auto-allow with input passthrough (the
 *     `permissionMode: 'default'` contract — see PRD §SDK option choices).
 *   - `AskUserQuestion` builds a live `AskBatch` from the structured input,
 *     emits it onto the bus, awaits resolution, and returns the SDK's
 *     `answers: { [questionText]: string }` shape on `updatedInput`. Multi-
 *     select answers are joined as a single comma-separated string per the
 *     SDK's own field comment at `sdk-tools.d.ts:2702`.
 *
 * Decline / unmatched / bus-rejection deny shapes are #006's slice — this
 * file only covers the happy path. See `docs/issues/claude-sdk-agent-driver/
 * 004-live-ask-userquestion-happy-path.md` and the boundary stamp in
 * `src/agents/claude/sdk-message-projector.ts`.
 */

import { describe, expect, it } from 'vitest';
import { AskBusTimeoutError, createAskBus } from '../src/sdk/ask-bus/bus.js';
import { createAskUserBridge } from '../src/agents/claude/ask-user-bridge.js';
import { createAskUserAnswerStore } from '../src/agents/claude/ask-user-answer-store.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';

const PERMISSION_CTX = {
    signal: new AbortController().signal,
    suggestions: [],
    toolUseID: 'tool-use-test',
};

describe('ask-user-bridge canUseTool', () => {
    it('allows every non-AskUserQuestion tool with input passed through unchanged', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });
        const input = { command: 'ls' };
        const result = await canUseTool('Bash', input, PERMISSION_CTX);
        expect(result.behavior).toBe('allow');
        if (result.behavior === 'allow') {
            expect(result.updatedInput).toEqual(input);
        }
    });

    it('emits a live AskBatch with the SDK input mapped onto questions/options/headers', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const seen: AskBatch[] = [];
        // Subscriber answers the single question so the bridge's await returns.
        bus.onAsk((batch, respond) => {
            seen.push(batch);
            respond({
                answers: [
                    { questionId: batch.questions[0].id, values: ['SQLite'], source: 'reaction' },
                ],
            });
        });

        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 7,
            answerStore: createAskUserAnswerStore(),
        });

        const input = {
            questions: [
                {
                    question: 'Which database should we use?',
                    header: 'Database',
                    multiSelect: false,
                    options: [
                        { label: 'SQLite', description: 'Local file' },
                        { label: 'Postgres', description: 'Server' },
                    ],
                },
            ],
        };

        await canUseTool('AskUserQuestion', input, {
            ...PERMISSION_CTX,
            toolUseID: 'claude-tool-use-42',
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            batchId: 'claude-tool-use-42',
            turnNumber: 7,
            source: 'claude',
            lifecycle: 'live',
            sourceTool: 'AskUserQuestion',
            toolUseId: 'claude-tool-use-42',
        });
        expect(seen[0].questions).toHaveLength(1);
        expect(seen[0].questions[0]).toMatchObject({
            id: 'q-0',
            header: 'Database',
            question: 'Which database should we use?',
            isOther: false,
            isSecret: false,
        });
        expect(seen[0].questions[0].options).toEqual([
            { label: 'SQLite', description: 'Local file' },
            { label: 'Postgres', description: 'Server' },
        ]);
    });

    it('returns the reaction answer keyed by question text in the SDK answers shape', async () => {
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: [
                    { questionId: batch.questions[0].id, values: ['SQLite'], source: 'reaction' },
                ],
            });
        });

        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });

        const input = {
            questions: [
                {
                    question: 'Which database should we use?',
                    header: 'Database',
                    multiSelect: false,
                    options: [
                        { label: 'SQLite', description: 'Local file' },
                        { label: 'Postgres', description: 'Server' },
                    ],
                },
            ],
        };

        const result = await canUseTool('AskUserQuestion', input, PERMISSION_CTX);

        expect(result.behavior).toBe('allow');
        if (result.behavior !== 'allow') return;
        // SDK shape: `answers: { [questionText]: string }` per
        // `sdk-tools.d.ts:2702`. The bridge merges that onto the original
        // input so the SDK sees the full handshake on `updatedInput`.
        expect(result.updatedInput).toEqual({
            ...input,
            answers: { 'Which database should we use?': 'SQLite' },
        });
    });

    it('joins multi-select answer values into a comma-separated string per SDK contract', async () => {
        // The SDK's `AskUserQuestionOutput.answers` field at
        // `sdk-tools.d.ts:2702` is documented as
        //   `{ [questionText]: string; multi-select answers are comma-separated }`.
        // The separator is the SDK's contract, not pathgrade's; the bridge
        // joins on a bare comma without imposing a stricter "comma-space"
        // assumption. (See PRD §Module decomposition / Ask-user-bridge.)
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: [
                    {
                        questionId: batch.questions[0].id,
                        values: ['Email', 'Slack', 'SMS'],
                        source: 'reaction',
                    },
                ],
            });
        });
        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });

        const input = {
            questions: [
                {
                    question: 'Which channels?',
                    header: 'Channels',
                    multiSelect: true,
                    options: [
                        { label: 'Email', description: 'e' },
                        { label: 'Slack', description: 's' },
                        { label: 'SMS', description: 't' },
                    ],
                },
            ],
        };

        const result = await canUseTool('AskUserQuestion', input, PERMISSION_CTX);

        expect(result.behavior).toBe('allow');
        if (result.behavior !== 'allow') return;
        const updated = result.updatedInput as { answers: Record<string, string> };
        expect(updated.answers).toEqual({ 'Which channels?': 'Email,Slack,SMS' });
    });
});

describe('ask-user-bridge canUseTool — #006 declined / bus-rejection denies', () => {
    it('returns SDK deny when every question resolves with source: "declined" (User Story #29)', async () => {
        // The `decline` fallback path (and the explicit declined `'error'`
        // path that ends the turn) both surface every answer with empty
        // values + `source: 'declined'`. Translating that to a bare allow
        // with empty `answers` would make Claude believe the user had
        // answered with empty strings; the SDK's documented `deny`
        // behavior is the right shape. PRD §AskUserQuestion bridge.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: batch.questions.map((q) => ({
                    questionId: q.id,
                    values: [],
                    source: 'declined' as const,
                })),
            });
        });
        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });
        const input = {
            questions: [
                {
                    question: 'Which database should we use?',
                    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                    multiSelect: false,
                },
            ],
        };
        const result = await canUseTool('AskUserQuestion', input, PERMISSION_CTX);
        expect(result).toEqual({ behavior: 'deny', message: 'User declined to answer' });
    });

    it('returns SDK deny with the bus error message when the live batch times out', async () => {
        // Use a 0ms timeout so the bus rejects on the next tick even with no
        // subscriber installed. The bridge translates the rejection into the
        // SDK's `deny` shape (so the model sees a refusal) AND records the
        // error on the bridge's `lastError()` accessor so the driver can
        // throw it after the turn ends — that's how the conversation runner
        // sees `completionReason: 'error'`. PRD §AskUserQuestion bridge.
        const bus = createAskBus({ askUserTimeoutMs: 0 });
        const bridge = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });
        const result = await bridge(
            'AskUserQuestion',
            { questions: [{ question: 'q?', options: [{ label: 'x' }] }] },
            { ...PERMISSION_CTX, toolUseID: 'tu-timeout' },
        );
        expect(result.behavior).toBe('deny');
        if (result.behavior !== 'deny') return;
        expect(result.message).toMatch(/did not resolve within 0ms/);
        const captured = bridge.lastError();
        expect(captured).toBeInstanceOf(AskBusTimeoutError);
        expect((captured as AskBusTimeoutError).batchId).toBe('tu-timeout');
        expect((captured as AskBusTimeoutError).turnNumber).toBe(1);
    });

    it('still records the declined answer source on the per-turn store so the projector can stamp it', async () => {
        // Even on a deny, the projector still sees the AskUserQuestion
        // tool_use block in the assistant message and stamps an envelope.
        // The bridge writes `source: 'declined'` into the store so the
        // projector can pick the same source instead of the default
        // `'unknown'` boundary stamp.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: batch.questions.map((q) => ({
                    questionId: q.id,
                    values: [],
                    source: 'declined' as const,
                })),
            });
        });
        const store = createAskUserAnswerStore();
        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: store,
        });
        await canUseTool(
            'AskUserQuestion',
            { questions: [{ question: 'q?', options: [{ label: 'x' }] }] },
            { ...PERMISSION_CTX, toolUseID: 'tu-decline' },
        );
        expect(store.get('tu-decline')).toEqual({
            answers: { 'q?': '' },
            source: 'declined',
        });
    });
});
