import type { ToolEvent } from '../../tool-events.js';
import { buildSummary } from '../../tool-events.js';
import type { AskAnswerSource, AskBatchSnapshot, AskSource } from './types.js';

export interface AskUserToolEventQuestionArgument {
    readonly id: string;
    readonly header?: string;
    readonly question: string;
    readonly isOther: boolean;
    readonly isSecret: boolean;
    readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }> | null;
    readonly answer?: {
        readonly values: readonly string[];
        readonly source: AskAnswerSource;
    };
}

export interface AskUserToolEventArguments {
    readonly batchId: string;
    readonly questions: readonly AskUserToolEventQuestionArgument[];
}

export type AskUserToolEvent = Omit<ToolEvent, 'action' | 'arguments'> & {
    readonly action: 'ask_user';
    readonly arguments: AskUserToolEventArguments;
};

function providerFromSource(source: AskSource): ToolEvent['provider'] {
    if (source === 'codex-app-server') return 'codex';
    return source;
}

export function toAskUserToolEvent(snapshot: AskBatchSnapshot): AskUserToolEvent {
    const answersById = new Map<string, { values: readonly string[]; source: AskAnswerSource }>();
    if (snapshot.resolution) {
        for (const a of snapshot.resolution.answers) {
            answersById.set(a.questionId, { values: a.values, source: a.source });
        }
    }

    const questions = snapshot.questions.map((q) => {
        const answer = answersById.get(q.id);
        return {
            id: q.id,
            ...(q.header ? { header: q.header } : {}),
            question: q.question,
            isOther: q.isOther,
            isSecret: q.isSecret,
            options: q.options === null
                ? null
                : q.options.map((o) => ({
                    label: o.label,
                    ...(o.description ? { description: o.description } : {}),
                })),
            ...(answer ? { answer: { values: [...answer.values], source: answer.source } } : {}),
        };
    });

    const args: AskUserToolEventArguments = {
        batchId: snapshot.batchId,
        questions,
    };

    return {
        action: 'ask_user',
        provider: providerFromSource(snapshot.source),
        providerToolName: snapshot.sourceTool,
        turnNumber: snapshot.turnNumber,
        arguments: args,
        summary: buildSummary('ask_user', snapshot.sourceTool, args as unknown as Record<string, unknown>),
        confidence: 'high',
        rawSnippet: '',
    };
}
