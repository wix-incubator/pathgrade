import type { Agent, RecordedEvalResult } from './types.js';

export interface EvalResultEvent {
    readonly result: RecordedEvalResult;
    readonly agent: Agent;
}

export type EvalResultObserver = (event: EvalResultEvent) => void;
export type ResultObserverOwner = 'user' | 'adapter' | 'test';

export interface ResultObserverOptions {
    readonly owner?: ResultObserverOwner;
    readonly key?: string;
}

export interface ResultObserverHandle {
    unsubscribe(): void;
}

interface ObserverSubscription {
    readonly observer: EvalResultObserver;
    readonly owner: ResultObserverOwner;
    readonly key?: string;
}

const observers = new Set<ObserverSubscription>();

export function subscribeToEvalResults(
    observer: EvalResultObserver,
    options: ResultObserverOptions = {},
): ResultObserverHandle {
    if (options.owner === 'adapter' && options.key) {
        removeObserverByOwnerAndKey(options.owner, options.key);
    }
    const subscription: ObserverSubscription = {
        observer,
        owner: options.owner ?? 'user',
        key: options.key,
    };
    observers.add(subscription);
    let active = true;

    return {
        unsubscribe() {
            if (!active) return;
            active = false;
            observers.delete(subscription);
        },
    };
}

export function emitEvalResult(event: EvalResultEvent): void {
    for (const subscription of [...observers]) {
        try {
            subscription.observer(event);
        } catch {
            // Result capture should be best-effort for every observer; one
            // broken hook must not block adapter-owned reporting.
        }
    }
}

export function resetUserResultObservers(): void {
    for (const subscription of [...observers]) {
        if (subscription.owner === 'user') {
            observers.delete(subscription);
        }
    }
}

export function resetAllResultObserversForTests(): void {
    observers.clear();
}

function removeObserverByOwnerAndKey(owner: ResultObserverOwner, key: string): void {
    for (const subscription of [...observers]) {
        if (subscription.owner === owner && subscription.key === key) {
            observers.delete(subscription);
        }
    }
}
