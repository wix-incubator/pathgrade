import { AsyncLocalStorage } from 'node:async_hooks';

export type CaseContextScope = 'runner-case' | 'runner-suite-shared';

export interface CaseContext {
    caseId: string;
    caseName: string;
    filePath: string;
    scope: CaseContextScope;
}

export type CurrentCaseContext =
    | { status: 'empty' }
    | { status: 'active'; context: CaseContext };

export interface CaseContextProviderHandle {
    restore(): void;
}

export type CaseContextProvider = () => CaseContext | null | undefined;

const caseContextStorage = new AsyncLocalStorage<CaseContext>();
const providers: CaseContextProvider[] = [];

export function getCurrentCaseContext(): CurrentCaseContext {
    const context = caseContextStorage.getStore();
    if (context) return { status: 'active', context };

    for (const provider of providers.toReversed()) {
        const provided = provider();
        if (provided) return { status: 'active', context: provided };
    }

    return { status: 'empty' };
}

export function runWithCaseContext<T>(context: CaseContext, run: () => T): T {
    return caseContextStorage.run(context, run);
}

export function installCaseContextProvider(provider: CaseContextProvider): CaseContextProviderHandle {
    providers.push(provider);
    let restored = false;

    return {
        restore() {
            if (restored) return;
            restored = true;
            const index = providers.lastIndexOf(provider);
            if (index >= 0) providers.splice(index, 1);
        },
    };
}
