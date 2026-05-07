/**
 * Tests for the SDK-message-projector module.
 *
 * The projector is a pure function over the typed SDK message stream that
 * produces an `AgentTurnResult` plus the session id the orchestrator uses for
 * `Options.resume` on the next turn. It replaces the legacy NDJSON parser
 * (`extractClaudeStreamJsonEvents`) wholesale: every behavior the parser
 * exercised — assistant text, tool events, skill enrichment, slash-command
 * skill detection, init/result metadata — is now driven by typed
 * `SDKMessage` values instead of stringified NDJSON.
 *
 * Boundary with the live ask-user bridge: the projector emits an
 * `AskUserQuestion` ToolEvent whose `arguments` carry the structured
 * `AskUserQuestionInput` (questions/headers/options/multiSelect) plus
 * `answerSource: 'unknown'`. The actual answer values and the
 * `'reaction' | 'fallback' | 'declined'` source tag are attached on the same
 * envelope by the ask-user-bridge; the projector itself never mints them.
 */

import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { projectSdkMessages } from '../src/agents/claude/sdk-message-projector.js';
import { createAskUserAnswerStore } from '../src/agents/claude/ask-user-answer-store.js';

// --- typed-message fixtures (kept terse; cast through `unknown` for the
// fields the SDK requires that aren't relevant to what each test asserts).

function initMessage(overrides: Partial<{
    sessionId: string;
    skills: string[];
    tools: string[];
    slash_commands: string[];
}> = {}): SDKMessage {
    return {
        type: 'system',
        subtype: 'init',
        session_id: overrides.sessionId ?? 'sess-1',
        agents: [],
        apiKeySource: 'none',
        claude_code_version: '0.0.0-test',
        cwd: '/tmp/workspace',
        tools: overrides.tools ?? [],
        mcp_servers: [],
        model: 'claude-opus-4-7',
        permissionMode: 'default',
        slash_commands: overrides.slash_commands ?? [],
        output_style: 'default',
        skills: overrides.skills ?? [],
        plugins: [],
        uuid: 'init-uuid',
    } as unknown as SDKMessage;
}

function assistantText(text: string, sessionId = 'sess-1'): SDKMessage {
    return {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid: 'assistant-uuid',
        session_id: sessionId,
    } as unknown as SDKMessage;
}

function assistantToolUse(
    name: string,
    input: Record<string, unknown>,
    sessionId = 'sess-1',
): SDKMessage {
    return {
        type: 'assistant',
        message: {
            content: [
                { type: 'tool_use', id: `toolu-${name}`, name, input },
            ],
        },
        parent_tool_use_id: null,
        uuid: 'assistant-uuid',
        session_id: sessionId,
    } as unknown as SDKMessage;
}

function resultSuccess(overrides: Partial<{
    sessionId: string;
    text: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    totalCostUsd: number;
}> = {}): SDKMessage {
    return {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: overrides.text ?? '',
        stop_reason: 'end_turn',
        total_cost_usd: overrides.totalCostUsd ?? 0,
        usage: {
            input_tokens: overrides.inputTokens ?? 0,
            output_tokens: overrides.outputTokens ?? 0,
            cache_creation_input_tokens: overrides.cacheCreation ?? 0,
            cache_read_input_tokens: overrides.cacheRead ?? 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: 'result-uuid',
        session_id: overrides.sessionId ?? 'sess-1',
    } as unknown as SDKMessage;
}

function resultError(subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries' = 'error_during_execution'): SDKMessage {
    return {
        type: 'result',
        subtype,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        errors: [],
        uuid: 'result-uuid',
        session_id: 'sess-err',
    } as unknown as SDKMessage;
}

describe('projectSdkMessages — empty input', () => {
    it('returns a structurally-valid AgentTurnResult for an empty message stream', () => {
        const projected = projectSdkMessages({ messages: [] });
        expect(projected.result.assistantMessage).toBe('');
        expect(projected.result.visibleAssistantMessage).toBe('');
        expect(projected.result.visibleAssistantMessageSource).toBe('assistant_message');
        expect(projected.result.exitCode).toBe(0);
        expect(projected.result.toolEvents).toEqual([]);
        expect(projected.result.runtimePoliciesApplied).toEqual([]);
        expect(projected.sessionId).toBeUndefined();
    });
});

describe('projectSdkMessages — session id', () => {
    it('captures session_id from the init message', () => {
        const projected = projectSdkMessages({
            messages: [initMessage({ sessionId: 'sess-init' })],
        });
        expect(projected.sessionId).toBe('sess-init');
    });

    it('captures session_id from a result message even without an init', () => {
        const projected = projectSdkMessages({
            messages: [resultSuccess({ sessionId: 'sess-result' })],
        });
        expect(projected.sessionId).toBe('sess-result');
    });

    it('prefers the result session_id when both are present (last-write-wins)', () => {
        // The SDK guarantees init.session_id and result.session_id are equal
        // for non-resumed turns; the projector still respects message order so
        // a downstream caller never sees a stale id.
        const projected = projectSdkMessages({
            messages: [
                initMessage({ sessionId: 'sess-init' }),
                resultSuccess({ sessionId: 'sess-final' }),
            ],
        });
        expect(projected.sessionId).toBe('sess-final');
    });
});

describe('projectSdkMessages — assistant text', () => {
    it('concatenates text blocks across assistant messages into assistantMessage', () => {
        const projected = projectSdkMessages({
            messages: [
                initMessage(),
                assistantText('Hello, '),
                assistantText('world!'),
                resultSuccess({ text: 'Hello, world!' }),
            ],
        });
        expect(projected.result.assistantMessage).toBe('Hello, world!');
        expect(projected.result.visibleAssistantMessage).toBe('Hello, world!');
        expect(projected.result.visibleAssistantMessageSource).toBe('assistant_message');
    });

    it('falls back to result.result text when no assistant text blocks were emitted', () => {
        // Some Claude turns answer entirely through tool use and surface the
        // final answer only on the result message; the projector preserves
        // that fallback so consumers always see the model's last word.
        const projected = projectSdkMessages({
            messages: [
                initMessage(),
                resultSuccess({ text: 'final-answer-only' }),
            ],
        });
        expect(projected.result.assistantMessage).toBe('final-answer-only');
        expect(projected.result.visibleAssistantMessage).toBe('final-answer-only');
    });

    it('uses rawOutput as the joined assistant + result text for downstream debug', () => {
        const projected = projectSdkMessages({
            messages: [
                initMessage(),
                assistantText('intermediate '),
                resultSuccess({ text: 'final' }),
            ],
        });
        expect(projected.result.rawOutput.length).toBeGreaterThan(0);
        expect(projected.result.rawOutput).toContain('final');
    });
});

describe('projectSdkMessages — usage and exit code', () => {
    it('totalizes inputTokens as input + cache_creation + cache_read (matches existing pathgrade convention)', () => {
        // The convention pre-existed under the NDJSON parser at
        // src/agents/claude.ts:223-227; test fixtures elsewhere already treat
        // cache tokens as billable input volume. The projector preserves this
        // total — `inputTokens` keeps including cache tokens, and the new
        // cache breakdown fields are additive on top.
        const projected = projectSdkMessages({
            messages: [
                resultSuccess({
                    inputTokens: 100,
                    cacheCreation: 30,
                    cacheRead: 70,
                    outputTokens: 25,
                }),
            ],
        });
        expect(projected.result.inputTokens).toBe(200);
        expect(projected.result.outputTokens).toBe(25);
    });

    it('exposes cacheCreationInputTokens and cacheReadInputTokens as additive breakdown fields', () => {
        // The projector also populates the new optional breakdown fields
        // sourced from the SDK's
        // `cache_creation_input_tokens` / `cache_read_input_tokens` so consumers
        // can reason about cache volume separately from the totalized
        // `inputTokens` figure. The total above is still the canonical
        // billable-volume value.
        const projected = projectSdkMessages({
            messages: [
                resultSuccess({
                    inputTokens: 100,
                    cacheCreation: 30,
                    cacheRead: 70,
                    outputTokens: 25,
                }),
            ],
        });
        expect(projected.result.cacheCreationInputTokens).toBe(30);
        expect(projected.result.cacheReadInputTokens).toBe(70);
    });

    it('exposes costUsd from a successful result message', () => {
        // The projector populates `AgentTurnResult.costUsd` from the SDK's
        // `total_cost_usd` so
        // consumers can budget runs against expensive models. Non-zero costs
        // round-trip without modification — pathgrade does not impose its
        // own pricing model on top of what the SDK reports.
        const projected = projectSdkMessages({
            messages: [resultSuccess({ totalCostUsd: 0.0125 })],
        });
        expect(projected.result.costUsd).toBe(0.0125);
    });

    it('exposes costUsd from an error result message even when the turn failed', () => {
        // Cost projection covers both SDKResultSuccess.total_cost_usd and
        // SDKResultError.total_cost_usd.
        // A turn that errored mid-execution still consumed tokens and money;
        // surfacing that lets the run-level total reflect the real spend
        // rather than implicitly rounding error turns to zero.
        const errorWithCost = {
            type: 'result',
            subtype: 'error_during_execution',
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            num_turns: 1,
            stop_reason: null,
            total_cost_usd: 0.004,
            usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            errors: [],
            uuid: 'result-uuid',
            session_id: 'sess-err',
        } as unknown as SDKMessage;
        const projected = projectSdkMessages({ messages: [errorWithCost] });
        expect(projected.result.exitCode).toBe(1);
        expect(projected.result.costUsd).toBe(0.004);
    });

    it('omits costUsd when the SDK does not report total_cost_usd', () => {
        // Defensive omission — same shape rule as the cache breakdown fields.
        // A consumer summing run-level cost should be able to detect "no
        // cost data" cleanly rather than treat it as a zero-cost turn.
        const noCost = {
            type: 'result',
            subtype: 'success',
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            uuid: 'result-uuid',
            session_id: 'sess-1',
        } as unknown as SDKMessage;
        const projected = projectSdkMessages({ messages: [noCost] });
        expect(projected.result.costUsd).toBeUndefined();
    });

    it('omits the cache breakdown fields when the SDK reports zero cache usage (no usage object)', () => {
        // Defensive: if the SDK ever stops reporting `usage` entirely (no
        // `usage` field on the result), the projector must not mint zero
        // breakdown values that would mislead a consumer counting cache hits.
        // The `inputTokens` / `outputTokens` field follows the same rule today.
        const noUsage = {
            type: 'result',
            subtype: 'success',
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: '',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            modelUsage: {},
            permission_denials: [],
            uuid: 'result-uuid',
            session_id: 'sess-1',
        } as unknown as SDKMessage;
        const projected = projectSdkMessages({ messages: [noUsage] });
        expect(projected.result.cacheCreationInputTokens).toBeUndefined();
        expect(projected.result.cacheReadInputTokens).toBeUndefined();
    });

    it('treats a successful result as exitCode 0 with the assistant message visible', () => {
        const projected = projectSdkMessages({
            messages: [
                assistantText('done'),
                resultSuccess({ text: 'done' }),
            ],
        });
        expect(projected.result.exitCode).toBe(0);
        expect(projected.result.assistantMessage).toBe('done');
        expect(projected.result.visibleAssistantMessage).toBe('done');
    });

    it('treats an error result subtype as exitCode 1 and blanks the visible assistant message', () => {
        // Visible blanking matches the legacy NDJSON parser's behavior so
        // scorers that key on "visibleAssistantMessage was non-empty" don't
        // record an error turn as if it produced a real answer.
        const projected = projectSdkMessages({
            messages: [
                assistantText('partial...'),
                resultError('error_max_turns'),
            ],
        });
        expect(projected.result.exitCode).toBe(1);
        expect(projected.result.assistantMessage).toBe('');
        expect(projected.result.visibleAssistantMessage).toBe('');
    });

    it('treats every documented SDKResultError subtype as exitCode 1', () => {
        for (const subtype of [
            'error_during_execution',
            'error_max_turns',
            'error_max_budget_usd',
            'error_max_structured_output_retries',
        ] as const) {
            const projected = projectSdkMessages({
                messages: [resultError(subtype)],
            });
            expect(projected.result.exitCode, `subtype ${subtype}`).toBe(1);
        }
    });

    it('exposes the typed errorSubtype for each documented SDKResultError variant', () => {
        // The legacy CLI driver scraped the result text with a regex to
        // distinguish error categories. The SDK projector reads the typed
        // `subtype` field and surfaces it directly so consumers can triage
        // failures (max-turns vs budget vs execution) without parsing prose.
        for (const subtype of [
            'error_during_execution',
            'error_max_turns',
            'error_max_budget_usd',
            'error_max_structured_output_retries',
        ] as const) {
            const projected = projectSdkMessages({
                messages: [resultError(subtype)],
            });
            expect(projected.result.errorSubtype, `subtype ${subtype}`).toBe(subtype);
        }
    });

    it('does not set errorSubtype on a successful turn', () => {
        const projected = projectSdkMessages({
            messages: [resultSuccess({ text: 'done' })],
        });
        expect(projected.result.errorSubtype).toBeUndefined();
    });
});

describe('projectSdkMessages — tool events from tool_use blocks', () => {
    it('extracts a tool event per tool_use block, mapping provider tool names to actions', () => {
        const projected = projectSdkMessages({
            messages: [
                initMessage(),
                assistantToolUse('Read', { file_path: 'src/app.ts' }),
                assistantToolUse('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }),
                assistantToolUse('Bash', { command: 'npm test' }),
                resultSuccess({ text: 'done' }),
            ],
        });
        expect(projected.result.toolEvents).toEqual([
            expect.objectContaining({ action: 'read_file', providerToolName: 'Read', provider: 'claude' }),
            expect.objectContaining({ action: 'edit_file', providerToolName: 'Edit', provider: 'claude' }),
            expect.objectContaining({ action: 'run_shell', providerToolName: 'Bash', provider: 'claude' }),
        ]);
    });

    it('keeps the structured input as ToolEvent.arguments without stringifying', () => {
        const projected = projectSdkMessages({
            messages: [
                assistantToolUse('Bash', { command: 'npm test' }),
                resultSuccess(),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0].arguments).toEqual({ command: 'npm test' });
        expect(projected.result.toolEvents[0].summary).toBe('npm test');
    });

    it('forwards turnNumber onto every emitted tool event', () => {
        const projected = projectSdkMessages({
            turnNumber: 4,
            messages: [
                assistantToolUse('Bash', { command: 'ls' }),
                resultSuccess(),
            ],
        });
        expect(projected.result.toolEvents[0].turnNumber).toBe(4);
    });

    it('preserves tool_use order across multiple assistant messages with multiple blocks', () => {
        const projected = projectSdkMessages({
            messages: [
                {
                    type: 'assistant',
                    message: {
                        content: [
                            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
                            { type: 'text', text: 'reading a' },
                            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.ts' } },
                        ],
                    },
                    parent_tool_use_id: null,
                    uuid: 'a-uuid',
                    session_id: 'sess-1',
                } as unknown as SDKMessage,
                assistantToolUse('Bash', { command: 'ls' }),
                resultSuccess(),
            ],
        });
        expect(projected.result.toolEvents.map((e) => e.arguments)).toEqual([
            { file_path: 'a.ts' },
            { file_path: 'b.ts' },
            { command: 'ls' },
        ]);
    });

    it('caps rawSnippet at 200 characters even for long tool_use inputs', () => {
        const longCmd = 'x'.repeat(500);
        const projected = projectSdkMessages({
            messages: [assistantToolUse('Bash', { command: longCmd })],
        });
        expect(projected.result.toolEvents[0].rawSnippet.length).toBeLessThanOrEqual(200);
    });

    it('falls back to action="unknown" for an unmapped provider tool name', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('SomeFutureTool', { x: 1 })],
        });
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'unknown',
            providerToolName: 'SomeFutureTool',
            provider: 'claude',
        });
    });
});

describe('projectSdkMessages — skill enrichment', () => {
    it('marks an explicit Skill tool call as use_skill with the skill name from arguments', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('Skill', { skill: 'tdd', args: '' })],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'use_skill',
            providerToolName: 'Skill',
            provider: 'claude',
            skillName: 'tdd',
        });
    });

    it('reclassifies Read on a SKILL.md path as use_skill with the parent dir as skillName', () => {
        const projected = projectSdkMessages({
            messages: [
                assistantToolUse('Read', { file_path: '/workspace/.claude/skills/debugging/SKILL.md' }),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'use_skill',
            providerToolName: 'Read',
            provider: 'claude',
            skillName: 'debugging',
        });
    });

    it('leaves Read on a non-SKILL.md path as a plain read_file event with no skillName', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('Read', { file_path: 'src/app.ts' })],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'read_file',
            providerToolName: 'Read',
        });
        expect(projected.result.toolEvents[0].skillName).toBeUndefined();
    });
});

describe('projectSdkMessages — slash-command skill synthesis', () => {
    it('prepends a synthetic use_skill event when firstMessage starts with /<name> and <name> is in init.skills', () => {
        const projected = projectSdkMessages({
            firstMessage: '/ck-handoff Create a handoff doc',
            messages: [
                initMessage({ skills: ['ck-handoff', 'tdd'] }),
                assistantToolUse('Bash', { command: 'ls' }),
            ],
        });
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'use_skill',
            provider: 'claude',
            providerToolName: 'Skill',
            skillName: 'ck-handoff',
        });
        expect(projected.result.toolEvents[0].arguments).toEqual({ skill: 'ck-handoff' });
        // The Bash event still follows.
        expect(projected.result.toolEvents[1]).toMatchObject({
            action: 'run_shell',
            providerToolName: 'Bash',
        });
    });

    it('does not synthesize when the slash command is not in init.skills', () => {
        const projected = projectSdkMessages({
            firstMessage: '/unknown-skill do stuff',
            messages: [
                initMessage({ skills: ['tdd', 'debugging'] }),
                assistantToolUse('Bash', { command: 'ls' }),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({
            action: 'run_shell',
            providerToolName: 'Bash',
        });
    });

    it('does not synthesize when firstMessage is absent', () => {
        const projected = projectSdkMessages({
            messages: [
                initMessage({ skills: ['ck-handoff'] }),
                assistantToolUse('Bash', { command: 'ls' }),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({ action: 'run_shell' });
    });

    it('does not synthesize when firstMessage does not start with /', () => {
        const projected = projectSdkMessages({
            firstMessage: 'Create a handoff doc',
            messages: [
                initMessage({ skills: ['ck-handoff'] }),
                assistantToolUse('Bash', { command: 'ls' }),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({ action: 'run_shell' });
    });

    it('does not synthesize when there is no init message in the stream', () => {
        const projected = projectSdkMessages({
            firstMessage: '/ck-handoff Create a handoff',
            messages: [
                assistantToolUse('Bash', { command: 'ls' }),
            ],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        expect(projected.result.toolEvents[0]).toMatchObject({ action: 'run_shell' });
    });
});

describe('projectSdkMessages — AskUserQuestion projection (boundary with the bridge)', () => {
    // The projector emits a structurally-stable ask_user envelope from the
    // typed AskUserQuestion tool input. The bridge reuses the same envelope
    // and adds the answer values + 'reaction' | 'fallback' | 'declined' source.
    const askInput = {
        questions: [
            {
                question: 'Which package manager?',
                header: 'PM',
                options: [
                    { label: 'npm', description: 'Node Package Manager' },
                    { label: 'yarn', description: 'Yarn classic' },
                ],
                multiSelect: false,
            },
        ],
    };

    it('emits an ask_user tool event with the structured questions input preserved', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('AskUserQuestion', askInput)],
        });
        expect(projected.result.toolEvents).toHaveLength(1);
        const ev = projected.result.toolEvents[0];
        expect(ev.action).toBe('ask_user');
        expect(ev.providerToolName).toBe('AskUserQuestion');
        expect(ev.provider).toBe('claude');
        expect(ev.arguments?.questions).toEqual(askInput.questions);
    });

    it('tags the ask_user envelope with answerSource: "unknown" for the bridge to fill in', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('AskUserQuestion', askInput)],
        });
        expect(projected.result.toolEvents[0].arguments?.answerSource).toBe('unknown');
    });

    it('does NOT attach answer values or a reaction/fallback/declined source — that is the bridge', () => {
        const projected = projectSdkMessages({
            messages: [assistantToolUse('AskUserQuestion', askInput)],
        });
        const args = projected.result.toolEvents[0].arguments;
        // No legacy answer fields anywhere (the bridge will add them).
        expect(JSON.stringify(args)).not.toMatch(/"reaction"|"fallback"|"declined"/);
        expect(args).not.toHaveProperty('answers');
    });

    it('merges bridge-supplied answers + answerSource onto the ask_user envelope when supplied', () => {
        // The live ask-user bridge resolves the AskUserQuestion through
        // the bus and writes the SDK-shape `answers` map plus the source tag
        // into a per-turn `AskUserAnswerStore` keyed by `toolUseID`. The
        // projector consumes that store while building the ToolEvent so the
        // resulting envelope carries the supplied answers and the
        // `'reaction' | 'fallback' | 'declined'` source instead of the
        // pre-bridge `answerSource: 'unknown'` boundary stamp.
        const answerStore = createAskUserAnswerStore();
        answerStore.record('toolu-AskUserQuestion', {
            answers: { 'Which package manager?': 'yarn' },
            source: 'reaction',
        });
        const projected = projectSdkMessages({
            messages: [assistantToolUse('AskUserQuestion', askInput)],
            answerStore,
        });
        const args = projected.result.toolEvents[0].arguments;
        expect(args).toMatchObject({
            answers: { 'Which package manager?': 'yarn' },
            answerSource: 'reaction',
        });
        // Structured input still preserved alongside the answer fields.
        expect(args?.questions).toEqual(askInput.questions);
    });

    it('preserves multiSelect/header/options on each question (snapshot-stable shape)', () => {
        const multi = {
            questions: [
                {
                    question: 'Which features?',
                    header: 'Features',
                    options: [
                        { label: 'Auth', description: 'Authentication' },
                        { label: 'Billing', description: 'Subscription' },
                        { label: 'Audit', description: 'Audit log' },
                    ],
                    multiSelect: true,
                },
            ],
        };
        const projected = projectSdkMessages({
            messages: [assistantToolUse('AskUserQuestion', multi)],
        });
        const q0 = (projected.result.toolEvents[0].arguments?.questions as Array<Record<string, unknown>>)[0];
        expect(q0.multiSelect).toBe(true);
        expect(q0.header).toBe('Features');
        expect(q0.options).toEqual(multi.questions[0].options);
    });
});

describe('projectSdkMessages — runtime policies and trace output', () => {
    it('always returns runtimePoliciesApplied as an empty array', () => {
        // Claude's interactive-question transport is "reliable" post-migration,
        // so the non-interactive runtime policy is removed and the projector's
        // contract is to surface an empty applied-policies list.
        const projected = projectSdkMessages({
            messages: [
                initMessage(),
                assistantText('hi'),
                resultSuccess({ text: 'hi' }),
            ],
        });
        expect(projected.result.runtimePoliciesApplied).toEqual([]);
    });

    it('still returns an empty runtimePoliciesApplied for an error turn', () => {
        const projected = projectSdkMessages({
            messages: [resultError('error_during_execution')],
        });
        expect(projected.result.runtimePoliciesApplied).toEqual([]);
    });

    it('populates traceOutput with an NDJSON serialization of the typed message stream', () => {
        // traceOutput is a debugging surface (no scorer keys on it for Claude
        // post-migration; see tests/agents.test.ts:60-64 comment), but the
        // projector contract is that it is sourced from typed messages, not
        // from a CLI scrape. NDJSON keeps the per-line shape historical
        // diagnostic tooling expects without resurrecting the legacy parser.
        const projected = projectSdkMessages({
            messages: [
                initMessage({ sessionId: 'sess-trace' }),
                assistantText('hi'),
                resultSuccess({ sessionId: 'sess-trace', text: 'hi' }),
            ],
        });
        const trace = projected.result.traceOutput ?? '';
        const lines = trace.split('\n').filter((l) => l.length > 0);
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
        expect(trace).toContain('"type":"system"');
        expect(trace).toContain('"type":"assistant"');
        expect(trace).toContain('"type":"result"');
    });
});
