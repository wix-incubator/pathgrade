import type {
    AskAnswer,
    AskAnswerSnapshot,
    AskBatch,
    AskBatchSnapshot,
    AskBus,
    AskHandle,
    AskHandler,
    AskQuestion,
    AskResolution,
    AskResolutionSnapshot,
    Unsubscribe,
} from './types.js';

interface AskBusConfig {
    askUserTimeoutMs: number;
}

export class AskBusTimeoutError extends Error {
    readonly batchId: string;
    readonly turnNumber: number;
    constructor(batchId: string, turnNumber: number, timeoutMs: number) {
        super(`ask_user batch ${batchId} on turn ${turnNumber} did not resolve within ${timeoutMs}ms`);
        this.name = 'AskBusTimeoutError';
        this.batchId = batchId;
        this.turnNumber = turnNumber;
    }
}

interface PendingEntry {
    batch: AskBatch;
    resolution: AskResolution | null;
}

export function createAskBus(config: AskBusConfig): AskBus {
    const { askUserTimeoutMs } = config;
    const handlers = new Set<AskHandler>();
    const pending: PendingEntry[] = [];

    const redactAnswers = (
        answers: readonly AskAnswer[],
        questions: readonly AskQuestion[],
    ): AskAnswerSnapshot[] => {
        const secretIds = new Set(questions.filter((q) => q.isSecret).map((q) => q.id));
        return answers.map((answer) => {
            const isSecret = secretIds.has(answer.questionId);
            const shouldRedact = isSecret && (answer.source === 'reaction' || answer.source === 'fallback');
            return {
                questionId: answer.questionId,
                values: shouldRedact ? ['<redacted>'] : [...answer.values],
                source: answer.source,
            };
        });
    };

    const toSnapshot = (entry: PendingEntry): AskBatchSnapshot => {
        const resolution: AskResolutionSnapshot | null = entry.resolution
            ? { answers: redactAnswers(entry.resolution.answers, entry.batch.questions) }
            : null;
        return { ...entry.batch, resolution };
    };

    return {
        emit(batch: AskBatch): AskHandle {
            const entry: PendingEntry = { batch, resolution: null };
            pending.push(entry);

            if (batch.lifecycle === 'post-hoc') {
                let warned = false;
                let captured = false;
                for (const handler of handlers) {
                    try {
                        handler(batch, (resolution) => {
                            if (!captured) {
                                entry.resolution = resolution;
                                captured = true;
                            }
                            if (!warned) {
                                warned = true;
                                console.warn(
                                    `AskBus: responded to post-hoc batch ${batch.batchId} — ignored at the wire; use reactions for live batches`,
                                );
                            }
                        });
                    } catch (err) {
                        console.error('AskBus handler threw', err);
                    }
                }
                return {
                    batchId: batch.batchId,
                    resolution: Promise.resolve(null),
                };
            }

            // lifecycle === 'live'
            let resolveFn!: (value: AskResolution) => void;
            let rejectFn!: (err: Error) => void;
            const resolutionPromise = new Promise<AskResolution>((resolve, reject) => {
                resolveFn = resolve;
                rejectFn = reject;
            });

            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                rejectFn(new AskBusTimeoutError(batch.batchId, batch.turnNumber, askUserTimeoutMs));
            }, askUserTimeoutMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref?: () => void }).unref!();
            }

            const respond = (resolution: AskResolution) => {
                if (settled) {
                    console.debug(
                        `AskBus: late respond() on batch ${batch.batchId} — first-wins, ignored`,
                    );
                    return;
                }
                settled = true;
                clearTimeout(timer);
                entry.resolution = resolution;
                resolveFn(resolution);
            };

            for (const handler of handlers) {
                try {
                    handler(batch, respond);
                } catch (err) {
                    console.error('AskBus handler threw', err);
                }
            }

            return {
                batchId: batch.batchId,
                resolution: resolutionPromise as Promise<AskResolution | null>,
            };
        },

        onAsk(handler: AskHandler): Unsubscribe {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },

        snapshot(turnNumber?: number): readonly AskBatchSnapshot[] {
            const filtered = turnNumber === undefined
                ? pending
                : pending.filter((entry) => entry.batch.turnNumber === turnNumber);
            return filtered.map(toSnapshot);
        },
    };
}

export interface AgentSessionOptionsWithBus {
    askBus?: AskBus;
}

/**
 * Helper for drivers that MUST have a real subscriber because they emit
 * `lifecycle: 'live'` batches. Throws at driver construction when the bus is
 * missing — silently resolving to `null` would send an empty answer map on the
 * wire, which is a worse failure mode than refusing to start.
 */
export function requireAskBusForLiveBatches(
    sessionOptions: AgentSessionOptionsWithBus | undefined,
    driverName: string,
): AskBus {
    const bus = sessionOptions?.askBus;
    if (!bus) {
        throw new Error(
            `${driverName} requires AgentSessionOptions.askBus for live ask_user batches. ` +
                `Construct the session via createManagedSession or pass an AskBus explicitly.`,
        );
    }
    return bus;
}
