/**
 * Tests for src/agents/claude/ask-user-bridge.ts.
 *
 * The bridge is a pure function over `(askBus, getTurnNumber, answerStore) →
 * CanUseTool` that handles `AskUserQuestion` via a live ask-bus round-trip:
 *
 *   - Non-`AskUserQuestion` tools auto-allow with input passthrough (the
 *     `permissionMode: 'default'` contract).
 *   - `AskUserQuestion` builds a live `AskBatch` from the structured input,
 *     emits it onto the bus, awaits resolution, and returns the SDK's
 *     `answers: { [questionText]: string }` shape on `updatedInput`. Multi-
 *     select answers are joined as a single comma-separated string per the
 *     SDK's own field comment at `sdk-tools.d.ts:2702`.
 *
 * Decline / unmatched / bus-rejection deny shapes are covered separately;
 * this file covers the happy path.
 */

import { describe, expect, it } from 'vitest';
import { AskBusTimeoutError, createAskBus } from '../src/sdk/ask-bus/bus.js';
import { createAskUserBridge } from '../src/agents/claude/ask-user-bridge.js';
import { createAskUserAnswerStore } from '../src/agents/claude/ask-user-answer-store.js';
import { createAskUserHandler } from '../src/sdk/ask-bus/handler.js';
import type { AskBatch } from '../src/sdk/ask-bus/types.js';
import type { AskUserQuestion, AskUserReaction } from '../src/sdk/types.js';

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

    it('returns multi-select answers in the SDK comma-separated contract (separator-agnostic)', async () => {
        // The SDK's `AskUserQuestionOutput.answers` field at
        // `sdk-tools.d.ts:2702` is documented as
        //   `{ [questionText]: string; multi-select answers are comma-separated }`.
        // The separator is the SDK's contract, not pathgrade's. This
        // assertion verifies that all selected option labels are present
        // in a single comma-separated string but does NOT pin a specific
        // separator format (`","` vs `", "`) — the bridge follows whatever
        // the bundled binary expects.
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
        expect(Object.keys(updated.answers)).toEqual(['Which channels?']);
        const answer = updated.answers['Which channels?'];
        expect(typeof answer).toBe('string');
        // Every selected label is present in the answer string.
        expect(answer).toContain('Email');
        expect(answer).toContain('Slack');
        expect(answer).toContain('SMS');
        // The SDK's "comma-separated" contract: at least one comma between
        // labels for an N-label multi-select. We don't pin `","` vs `", "`.
        expect((answer.match(/,/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
});

describe('ask-user-bridge canUseTool — declined / bus-rejection denies', () => {
    it('returns SDK deny when every question resolves with source: "declined" (User Story #29)', async () => {
        // The `decline` fallback path (and the explicit declined `'error'`
        // path that ends the turn) both surface every answer with empty
        // values + `source: 'declined'`. Translating that to a bare allow
        // with empty `answers` would make Claude believe the user had
        // answered with empty strings; the SDK's documented `deny`
        // behavior is the right shape.
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
        // sees `completionReason: 'error'`.
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

describe('ask-user-bridge canUseTool — batches and free-text answers', () => {
    it('emits one live batch containing every question when AskUserQuestion supplies multiple', async () => {
        // Criterion 1: a single AskUserQuestion call with multiple questions
        // emits ONE live batch containing every question. The bridge keys
        // each pathgrade `AskQuestion` as `q-${index}` so the projector and
        // handler can address them independently.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const seen: AskBatch[] = [];
        bus.onAsk((batch, respond) => {
            seen.push(batch);
            respond({
                answers: batch.questions.map((q) => ({
                    questionId: q.id,
                    values: ['x'],
                    source: 'reaction' as const,
                })),
            });
        });
        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 3,
            answerStore: createAskUserAnswerStore(),
        });

        const input = {
            questions: [
                {
                    question: 'Which database should we use?',
                    header: 'Database',
                    multiSelect: false,
                    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                },
                {
                    question: 'Which auth method?',
                    header: 'Auth',
                    multiSelect: false,
                    options: [{ label: 'OAuth' }, { label: 'API key' }],
                },
                {
                    question: 'Enable telemetry?',
                    header: 'Telemetry',
                    multiSelect: false,
                    options: [{ label: 'Yes' }, { label: 'No' }],
                },
            ],
        };

        await canUseTool('AskUserQuestion', input, {
            ...PERMISSION_CTX,
            toolUseID: 'tu-multi-q',
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].batchId).toBe('tu-multi-q');
        expect(seen[0].toolUseId).toBe('tu-multi-q');
        expect(seen[0].questions).toHaveLength(3);
        expect(seen[0].questions.map((q) => q.id)).toEqual(['q-0', 'q-1', 'q-2']);
        expect(seen[0].questions.map((q) => q.question)).toEqual([
            'Which database should we use?',
            'Which auth method?',
            'Enable telemetry?',
        ]);
        expect(seen[0].questions.map((q) => q.header)).toEqual([
            'Database',
            'Auth',
            'Telemetry',
        ]);
    });

    it('returns a different answer per question keyed by question text', async () => {
        // Criterion 2: each question is matched independently and may receive
        // a different answer. The bridge's `answers` map (the SDK's
        // documented `{ [questionText]: string }` shape) must key each
        // question to its own resolved value — no smearing across questions.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            // Resolve each question with a distinct value to expose any
            // index/key mix-up.
            respond({
                answers: [
                    { questionId: batch.questions[0].id, values: ['Postgres'], source: 'reaction' },
                    { questionId: batch.questions[1].id, values: ['OAuth'], source: 'reaction' },
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
                    question: 'Which database?',
                    header: 'Database',
                    multiSelect: false,
                    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                },
                {
                    question: 'Which auth?',
                    header: 'Auth',
                    multiSelect: false,
                    options: [{ label: 'OAuth' }, { label: 'API key' }],
                },
            ],
        };
        const result = await canUseTool('AskUserQuestion', input, PERMISSION_CTX);
        expect(result.behavior).toBe('allow');
        if (result.behavior !== 'allow') return;
        const updated = result.updatedInput as { answers: Record<string, string> };
        expect(updated.answers).toEqual({
            'Which database?': 'Postgres',
            'Which auth?': 'OAuth',
        });
    });

    it('passes free-text reaction answers through the same answers map as option answers', async () => {
        // Criterion 4: the SDK input always supplies 2-4 option labels, but
        // a reaction is free to return ANY string (User Story #28 — "the
        // reaction can answer questions with options OR free text"). The
        // bridge must not constrain answers to the option-label set; the
        // resulting `answers[questionText]` carries the reaction's string
        // verbatim. The bus subscriber here returns a value that is NOT one
        // of the input options — the bridge must still surface it.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        bus.onAsk((batch, respond) => {
            respond({
                answers: [
                    {
                        questionId: batch.questions[0].id,
                        values: ['MariaDB (custom write-in)'],
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
                    question: 'Which database?',
                    header: 'Database',
                    multiSelect: false,
                    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
                },
            ],
        };
        const result = await canUseTool('AskUserQuestion', input, PERMISSION_CTX);
        expect(result.behavior).toBe('allow');
        if (result.behavior !== 'allow') return;
        const updated = result.updatedInput as { answers: Record<string, string> };
        expect(updated.answers).toEqual({
            'Which database?': 'MariaDB (custom write-in)',
        });
    });

    it('exposes question text, header, options, and multi-select-derived shape to whenAsked predicates', async () => {
        // Criterion 5: predicate compatibility. A function-based `whenAsked`
        // is invoked once per question with the pathgrade-local
        // `AskUserQuestion` shape — the same fields it has always seen
        // (text, header, options, plus the id/isOther/isSecret structural
        // companions). Multi-select-derived shape: when the SDK input has
        // `multiSelect: true`, the question still surfaces with a populated
        // `options` array so the predicate can compare against the choice
        // list, AND the matching reaction's array-valued answer flows back
        // through the bus into a comma-joined string per the SDK contract
        // (criterion 3 below pins separator-agnostic). The bridge must wire
        // the bus handler such that each question runs the predicate
        // independently with its own structured shape.
        const bus = createAskBus({ askUserTimeoutMs: 1000 });
        const seenByPredicate: AskUserQuestion[] = [];
        const reactions: AskUserReaction[] = [
            {
                whenAsked: (q) => {
                    seenByPredicate.push(q);
                    return q.question === 'Which database?';
                },
                answer: 'Postgres',
            },
            {
                whenAsked: (q) => {
                    seenByPredicate.push(q);
                    return q.question === 'Which channels?';
                },
                // Multi-value answer — the bus's `AskAnswer.values` is a
                // string[], the bridge joins them per the SDK's
                // comma-separated contract.
                answer: ['Email', 'Slack'],
            },
        ];
        const handler = createAskUserHandler({
            reactions,
            onUnmatchedAskUser: 'error',
            firedOnce: new Set<number>(),
        });
        bus.onAsk(handler.handler);

        const canUseTool = createAskUserBridge({
            askBus: bus,
            getTurnNumber: () => 1,
            answerStore: createAskUserAnswerStore(),
        });

        const input = {
            questions: [
                {
                    question: 'Which database?',
                    header: 'Database',
                    multiSelect: false,
                    options: [
                        { label: 'SQLite', description: 'Local file' },
                        { label: 'Postgres', description: 'Server' },
                    ],
                },
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

        // Each question is matched independently against every reaction's
        // predicate until one fires — both reactions' whenAsked fns observed
        // both questions in some interleaving. Filter to the unique
        // question.question values to keep the assertion order-independent.
        const observedQuestionTexts = new Set(seenByPredicate.map((q) => q.question));
        expect(observedQuestionTexts).toEqual(new Set(['Which database?', 'Which channels?']));

        // Predicate sees structured pathgrade fields per `src/sdk/types.ts`
        // `AskUserQuestion`: id, header, question, isOther, isSecret, options.
        const dbObserved = seenByPredicate.find((q) => q.question === 'Which database?');
        expect(dbObserved).toMatchObject({
            id: 'q-0',
            header: 'Database',
            question: 'Which database?',
            isOther: false,
            isSecret: false,
            options: [
                { label: 'SQLite', description: 'Local file' },
                { label: 'Postgres', description: 'Server' },
            ],
        });
        // Multi-select-derived shape: even though the input set
        // `multiSelect: true`, the predicate sees the same structured
        // AskUserQuestion shape — populated `options` array, no
        // multiSelect-only fields leaking into pathgrade's predicate
        // contract. The reaction reacts to the same kind of object it
        // would for a single-select question. The second question in the
        // batch carries `id: 'q-1'` per the bridge's per-batch indexing.
        const channelsObserved = seenByPredicate.find((q) => q.question === 'Which channels?');
        expect(channelsObserved).toMatchObject({
            id: 'q-1',
            header: 'Channels',
            question: 'Which channels?',
            isOther: false,
            isSecret: false,
            options: [
                { label: 'Email', description: 'e' },
                { label: 'Slack', description: 's' },
                { label: 'SMS', description: 't' },
            ],
        });

        // The reactions resolved with their respective answers — the
        // multi-value answer for the multi-select question flows back as a
        // single comma-joined string.
        const updated = result.updatedInput as { answers: Record<string, string> };
        expect(updated.answers['Which database?']).toBe('Postgres');
        // Separator-agnostic: criterion 3. Assert presence of every
        // selected label and that the SDK's comma-separated shape is
        // honored (a single string, with each label as a substring).
        const channelsAnswer = updated.answers['Which channels?'];
        expect(typeof channelsAnswer).toBe('string');
        expect(channelsAnswer).toContain('Email');
        expect(channelsAnswer).toContain('Slack');
        expect(channelsAnswer).toContain(',');
        // No third label was selected — guard against a stray "SMS" from a
        // future bridge bug that might leak unrelated option labels.
        expect(channelsAnswer).not.toContain('SMS');
    });
});
