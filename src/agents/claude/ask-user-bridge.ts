/**
 * Ask-user bridge — `canUseTool` callback expressed as a pure factory over
 * `(askBus, getTurnNumber, answerStore)`. Issue #004.
 *
 * Replaces the placeholder deny installed by #001. PRD §Module decomposition
 * spells out the contract; the short version:
 *
 *   - For every tool name that is NOT `AskUserQuestion`, the bridge returns
 *     `{ behavior: 'allow', updatedInput: input }`. That matches the
 *     `permissionMode: 'default'` PRD choice — every tool decision still
 *     routes through this callback, but only `AskUserQuestion` actually
 *     blocks on the ask-bus.
 *   - For `AskUserQuestion`, the bridge constructs a live `AskBatch` from
 *     the SDK's already-typed `AskUserQuestionInput`, emits it onto the bus,
 *     awaits resolution, and returns the SDK's documented `answers` shape
 *     (`{ [questionText]: string }`, multi-select comma-joined per the SDK's
 *     own field comment) on `updatedInput`.
 *
 * Decline / unmatched / bus-rejection deny shapes are #006's slice. Until
 * then a declined `AskAnswer` (`source: 'declined'`) or a bus rejection
 * (`AskBusTimeoutError`) propagates as a thrown driver error or a generic
 * deny — that is the planned interim behavior, not a bug. #004 tests cover
 * only the answered-batch happy path.
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type {
    AskAnswer,
    AskBatch,
    AskBus,
    AskOption,
    AskQuestion,
} from '../../sdk/ask-bus/types.js';
import type { AskUserAnswerStore } from './ask-user-answer-store.js';

export interface AskUserBridgeDeps {
    /** Per-conversation bus from `AgentSessionOptions.askBus`. */
    askBus: AskBus;
    /** Returns the current turn number — driver increments before runTurn. */
    getTurnNumber: () => number;
    /** Per-turn answer store written here, read by the projector. */
    answerStore: AskUserAnswerStore;
}

/** Subset of `AskUserQuestionInput` the bridge consumes. Lifted from
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:566` (the SDK
 * exposes a heavily-tupled literal type — we read structurally to keep the
 * builder readable without losing the contract). */
interface ClaudeAskQuestion {
    question: unknown;
    header?: unknown;
    options?: ReadonlyArray<{ label?: unknown; description?: unknown }>;
    multiSelect?: unknown;
}

interface ClaudeAskInput {
    questions?: ReadonlyArray<ClaudeAskQuestion>;
}

export function createAskUserBridge(deps: AskUserBridgeDeps): CanUseTool {
    const { askBus, getTurnNumber, answerStore } = deps;

    return async (toolName, input, options) => {
        if (toolName !== 'AskUserQuestion') {
            return { behavior: 'allow', updatedInput: input };
        }

        const turnNumber = getTurnNumber();
        const batch = buildBatchFromInput(
            input as ClaudeAskInput,
            turnNumber,
            options.toolUseID,
        );
        const handle = askBus.emit(batch);
        const resolution = await handle.resolution;
        // Live batches always settle (either to a resolution or a rejection).
        // A null resolution means a 'post-hoc' batch — impossible here since
        // we just emitted lifecycle: 'live'. Throw if the bus contract is
        // ever weakened upstream.
        if (resolution === null) {
            throw new Error(
                `ask-user bridge: live batch ${batch.batchId} resolved to null`,
            );
        }

        const answers = buildSdkAnswers(batch.questions, resolution.answers);
        const source = pickAnswerSource(resolution.answers);
        answerStore.record(options.toolUseID, { answers, source });

        const allow: PermissionResult = {
            behavior: 'allow',
            updatedInput: { ...(input as Record<string, unknown>), answers },
        };
        return allow;
    };
}

/**
 * Build an `AskBatch` (lifecycle: 'live') from the SDK's `AskUserQuestionInput`.
 *
 * The SDK input is already typed and validated (1-4 questions, 2-4 options
 * each), so this is a structural translation rather than a parse. The batch
 * id reuses the SDK's `toolUseID` so the projector can join the resolution
 * back onto the matching `tool_use` block in the assistant message.
 */
function buildBatchFromInput(
    input: ClaudeAskInput,
    turnNumber: number,
    toolUseId: string,
): AskBatch {
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const questions: AskQuestion[] = [];
    rawQuestions.forEach((raw, index) => {
        const text = typeof raw.question === 'string' ? raw.question : '';
        const header = typeof raw.header === 'string' && raw.header.length > 0
            ? raw.header
            : undefined;
        const options = readOptions(raw.options);
        questions.push({
            id: `q-${index}`,
            ...(header ? { header } : {}),
            question: text,
            options,
            isOther: false,
            isSecret: false,
        });
    });
    return {
        batchId: toolUseId,
        turnNumber,
        source: 'claude',
        lifecycle: 'live',
        sourceTool: 'AskUserQuestion',
        toolUseId,
        questions,
    };
}

function readOptions(
    raw: ReadonlyArray<{ label?: unknown; description?: unknown }> | undefined,
): AskOption[] | null {
    if (!Array.isArray(raw)) return null;
    return raw.map((opt) => {
        const label = typeof opt.label === 'string' ? opt.label : '';
        const description = typeof opt.description === 'string' && opt.description.length > 0
            ? opt.description
            : undefined;
        return description ? { label, description } : { label };
    });
}

/**
 * Translate the bus's `AskAnswer[]` into the SDK's documented `answers` shape
 * — `{ [questionText]: string }` per `sdk-tools.d.ts:2702`. Multi-select is
 * joined with a single comma; the SDK's own field comment specifies that
 * "multi-select answers are comma-separated" without prescribing whitespace,
 * so we follow whatever the bundled binary expects rather than imposing a
 * stricter "comma-space" assumption.
 */
function buildSdkAnswers(
    questions: readonly AskQuestion[],
    answers: readonly AskAnswer[],
): Record<string, string> {
    const byId = new Map<string, AskAnswer>();
    for (const a of answers) byId.set(a.questionId, a);
    const out: Record<string, string> = {};
    for (const q of questions) {
        const a = byId.get(q.id);
        if (!a) continue;
        out[q.question] = a.values.join(',');
    }
    return out;
}

/**
 * Pick a single source tag for the whole batch. In the happy path every
 * question is answered by the same disposition; if mixed, the most-specific
 * source wins (`reaction` > `fallback` > `declined`). #006 will sharpen the
 * mixed-disposition behavior — for #004 the projector consumes a single tag
 * per tool event.
 */
function pickAnswerSource(answers: readonly AskAnswer[]): AskAnswer['source'] {
    if (answers.some((a) => a.source === 'reaction')) return 'reaction';
    if (answers.some((a) => a.source === 'fallback')) return 'fallback';
    return 'declined';
}
