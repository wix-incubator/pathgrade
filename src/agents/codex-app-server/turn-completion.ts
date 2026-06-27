interface TurnCompletedParams {
    turn?: {
        status?: string;
        error?: {
            message?: string;
            additionalDetails?: string | null;
        } | null;
    };
}

export function extractTurnCompletionFailure(params: unknown): string | undefined {
    const turn = (params as TurnCompletedParams | undefined)?.turn;
    const message = turn?.error?.message;
    const details = turn?.error?.additionalDetails;
    if (typeof message === 'string' && message.length > 0) {
        return typeof details === 'string' && details.length > 0 ? `${message} ${details}` : message;
    }
    return turn?.status === 'failed' ? 'turn failed' : undefined;
}
