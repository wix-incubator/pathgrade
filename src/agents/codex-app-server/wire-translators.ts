import type { AskQuestion, AskResolution } from '../../sdk/ask-bus/types.js';
import type {
    ToolRequestUserInputAnswer,
    ToolRequestUserInputQuestion,
    ToolRequestUserInputResponse,
} from './protocol/index.js';

/**
 * Upstream `request_user_input` → bus-facing `AskQuestion`.
 * - `header` preserves empty strings (never coerced to undefined).
 * - `options: null` stays null; otherwise maps label+description verbatim
 *   (empty-string description preserved).
 * - Strips any fields not in `AskQuestion`; no raw passthrough.
 */
export function normalizeUpstreamQuestion(
    q: ToolRequestUserInputQuestion,
): AskQuestion {
    return {
        id: q.id,
        header: q.header,
        question: q.question,
        isOther: q.isOther,
        isSecret: q.isSecret,
        options: q.options === null
            ? null
            : q.options.map((o) => ({ label: o.label, description: o.description })),
    };
}

/**
 * Bus-side `AskResolution` → upstream `UserInputAnswer` wire map.
 * - Missing entries emit `{answers: []}` and warn (upstream stalls on
 *   missing keys per protocol).
 * - `null` resolution (contract violation) yields an empty map for every
 *   question and warns. Driver's outer path should already have errored.
 * - `isSecret` values pass through raw — redaction is the bus snapshot's job.
 */
export function toWireAnswerMap(
    resolution: AskResolution | null,
    upstreamQuestions: readonly ToolRequestUserInputQuestion[],
): ToolRequestUserInputResponse['answers'] {
    const out: Record<string, ToolRequestUserInputAnswer | undefined> = {};

    if (resolution === null) {
        console.warn(
            `toWireAnswerMap: received null resolution — filling empty answers for ${upstreamQuestions.length} question(s)`,
        );
        for (const q of upstreamQuestions) {
            out[q.id] = { answers: [] };
        }
        return out;
    }

    const byId = new Map<string, readonly string[]>();
    for (const a of resolution.answers) {
        byId.set(a.questionId, a.values);
    }

    for (const q of upstreamQuestions) {
        const values = byId.get(q.id);
        if (values === undefined) {
            console.warn(
                `toWireAnswerMap: no answer for question ${q.id} — emitting empty array`,
            );
            out[q.id] = { answers: [] };
        } else {
            out[q.id] = { answers: [...values] };
        }
    }

    return out;
}
