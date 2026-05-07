/**
 * SDK message projector — typed `SDKMessage[]` → `AgentTurnResult`.
 *
 * Replaces the legacy NDJSON parser (`extractClaudeStreamJsonEvents`). Pure
 * function: no I/O, no ask-bus, no session state. The Claude SDK driver
 * buffers each turn's `SDKMessage` stream (`for await`) and hands the array
 * here; the projector returns the public `AgentTurnResult` plus the
 * `session_id` the orchestrator threads into the next turn's
 * `Options.resume`.
 *
 * Boundary with the live ask-user bridge: for an `AskUserQuestion`
 * tool-use block the projector emits a `ToolEvent` whose `arguments` shape
 * is the structured `AskUserQuestionInput` (questions / headers / options /
 * multiSelect) plus `answerSource: 'unknown'`. The bridge attaches the
 * answer values and the `'reaction' | 'fallback' | 'declined'` source tag
 * onto the same envelope; the projector itself never mints them.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTurnResult } from '../../types.js';

type SdkErrorSubtype = NonNullable<AgentTurnResult['errorSubtype']>;
const SDK_ERROR_SUBTYPES: readonly SdkErrorSubtype[] = [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
];
import type { ToolEvent } from '../../tool-events.js';
import { TOOL_NAME_MAP, buildSummary, enrichSkillEvents } from '../../tool-events.js';
import type { AskUserAnswerStore } from './ask-user-answer-store.js';

export interface ProjectTurnInput {
    /** Buffered typed-message stream from one `query()` call. */
    messages: SDKMessage[];
    /** Forwarded onto `ToolEvent.turnNumber`; optional for projector unit use. */
    turnNumber?: number;
    /** First user message of the turn — used for slash-command skill detection. */
    firstMessage?: string;
    /**
     * Optional per-turn answer store written by the ask-user-bridge.
     * When present, the projector merges `answers` + `answerSource` from the
     * store onto each `AskUserQuestion` ToolEvent envelope using the SDK's
     * `toolUseID` (the tool-use block `id`) as the join key. When absent or
     * empty for a given `toolUseID`, the projector keeps the boundary stamp
     * `answerSource: 'unknown'` it stamped before the bridge existed.
     */
    answerStore?: AskUserAnswerStore;
}

export interface ProjectedTurn {
    result: AgentTurnResult;
    /** `session_id` reported on init/result; the orchestrator uses this for `resume`. */
    sessionId?: string;
}

export function projectSdkMessages(input: ProjectTurnInput): ProjectedTurn {
    let sessionId: string | undefined;
    let initSkills: string[] | undefined;
    let assistantText = '';
    let resultText = '';
    let exitCode = 0;
    let isError = false;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;
    let cacheReadInputTokens: number | undefined;
    let costUsd: number | undefined;
    let errorSubtype: SdkErrorSubtype | undefined;
    const toolEvents: ToolEvent[] = [];

    for (const msg of input.messages) {
        switch (msg.type) {
            case 'system': {
                const sid = (msg as { session_id?: string }).session_id;
                if (sid) sessionId = sid;
                const sub = (msg as { subtype?: string }).subtype;
                if (sub === 'init') {
                    const skills = (msg as { skills?: unknown }).skills;
                    if (Array.isArray(skills)) initSkills = skills.filter((s): s is string => typeof s === 'string');
                }
                break;
            }
            case 'assistant': {
                const content = (msg as unknown as { message?: { content?: Array<Record<string, unknown>> } })
                    .message?.content ?? [];
                for (const block of content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        assistantText += block.text;
                        continue;
                    }
                    if (block.type === 'tool_use') {
                        toolEvents.push(buildToolEvent(block, input.turnNumber, input.answerStore));
                    }
                }
                break;
            }
            case 'result': {
                const r = msg as {
                    subtype?: string;
                    session_id?: string;
                    result?: string;
                    is_error?: boolean;
                    total_cost_usd?: number;
                    usage?: {
                        input_tokens?: number;
                        output_tokens?: number;
                        cache_creation_input_tokens?: number;
                        cache_read_input_tokens?: number;
                    };
                };
                if (r.session_id) sessionId = r.session_id;
                if (typeof r.result === 'string') resultText = r.result;
                if (r.usage) {
                    inputTokens =
                        (r.usage.input_tokens ?? 0)
                        + (r.usage.cache_creation_input_tokens ?? 0)
                        + (r.usage.cache_read_input_tokens ?? 0);
                    outputTokens = r.usage.output_tokens;
                    // Additive cache-token breakdown. `inputTokens` above
                    // keeps the existing pathgrade convention of including
                    // cache volume — these fields just expose the SDK's own
                    // breakdown for consumers that want to reason about cache
                    // hits/creation separately.
                    cacheCreationInputTokens = r.usage.cache_creation_input_tokens;
                    cacheReadInputTokens = r.usage.cache_read_input_tokens;
                }
                // Surface SDK-reported turn cost on success and error result
                // subtypes alike. The driver accumulates these into the
                // conversation cost downstream.
                if (typeof r.total_cost_usd === 'number') {
                    costUsd = r.total_cost_usd;
                }
                if (r.is_error || (r.subtype && r.subtype !== 'success')) {
                    isError = true;
                    exitCode = 1;
                    // Surface the SDK's typed error subtype so consumers can
                    // triage without regex on text.
                    if (r.subtype && (SDK_ERROR_SUBTYPES as readonly string[]).includes(r.subtype)) {
                        errorSubtype = r.subtype as SdkErrorSubtype;
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    const trimmedAssistant = assistantText.trim();
    const trimmedResult = resultText.trim();
    const visible = isError ? '' : (trimmedAssistant || trimmedResult);
    const rawOutput = resultText || assistantText;

    const enriched = enrichSkillEvents(toolEvents);
    const finalToolEvents = prependSlashCommandSkillEvent(
        enriched,
        input.firstMessage,
        initSkills,
    );
    const traceOutput = input.messages.map((m) => JSON.stringify(m)).join('\n');

    const result: AgentTurnResult = {
        rawOutput,
        assistantMessage: visible,
        visibleAssistantMessage: visible,
        visibleAssistantMessageSource: 'assistant_message',
        exitCode,
        traceOutput,
        toolEvents: finalToolEvents,
        runtimePoliciesApplied: [],
        inputTokens,
        outputTokens,
        ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(errorSubtype !== undefined ? { errorSubtype } : {}),
    };
    return { result, sessionId };
}

/**
 * If the first user message of the turn is `/<name>` and `<name>` is one of
 * the skills the SDK reported in its `init.skills` array, prepend a synthetic
 * `use_skill` tool event so scorers that key on `use_skill` see the implicit
 * skill activation. The Claude SDK does not emit a tool_use for slash-command
 * skill invocations the way an explicit `Skill` tool call does — this is the
 * NDJSON-era behavior the legacy parser also synthesized, preserved here.
 */
function prependSlashCommandSkillEvent(
    events: ToolEvent[],
    firstMessage: string | undefined,
    initSkills: string[] | undefined,
): ToolEvent[] {
    if (!firstMessage || !initSkills) return events;
    const match = firstMessage.match(/^\/([^\s]+)/);
    if (!match) return events;
    const skillName = match[1];
    if (!initSkills.includes(skillName)) return events;
    return [
        {
            action: 'use_skill',
            provider: 'claude',
            providerToolName: 'Skill',
            arguments: { skill: skillName },
            skillName,
            summary: `use_skill "${skillName}"`,
            confidence: 'high',
            rawSnippet: '(detected from slash command in prompt)',
        },
        ...events,
    ];
}

function buildToolEvent(
    block: Record<string, unknown>,
    turnNumber: number | undefined,
    answerStore: AskUserAnswerStore | undefined,
): ToolEvent {
    const providerToolName = String(block.name || 'unknown');
    const rawInput = (block.input as Record<string, unknown> | undefined) ?? undefined;
    const toolUseId = typeof block.id === 'string' ? block.id : undefined;
    const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
    const args = action === 'ask_user'
        ? buildAskUserArguments(rawInput, answerStore?.get(toolUseId))
        : rawInput;
    const summary = buildSummary(action, providerToolName, args);
    const rawSnippet = JSON.stringify(block).slice(0, 200);
    return {
        action,
        provider: 'claude',
        providerToolName,
        turnNumber,
        arguments: args,
        summary,
        confidence: 'high',
        rawSnippet,
    };
}

/**
 * Boundary with the ask-user bridge.
 *
 * The projector emits the structured `AskUserQuestionInput` (questions /
 * headers / options / multiSelect) plus `answerSource: 'unknown'`. The
 * ask-user-bridge attaches the answer values and the
 * `'reaction' | 'fallback' | 'declined'` source tag onto this same envelope.
 *
 * The projector itself never mints answer values, never mints a non-`unknown`
 * source, and never reaches into the bus — it just stamps the boundary so a
 * turn that produces an AskUserQuestion event without a bridge entry still
 * has a snapshot-stable shape for scorers and reporters.
 */
function buildAskUserArguments(
    input: Record<string, unknown> | undefined,
    bridgeEntry: { answers: Record<string, string>; source: string } | undefined,
): Record<string, unknown> {
    const base = input ? { ...input } : {};
    if (bridgeEntry) {
        return {
            ...base,
            answers: { ...bridgeEntry.answers },
            answerSource: bridgeEntry.source,
        };
    }
    return { ...base, answerSource: 'unknown' };
}
