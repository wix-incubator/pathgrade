import { installJestLifecycle } from './lifecycle.js';

const jestGlobals = globalThis as typeof globalThis & {
    beforeEach?: (fn: () => void | Promise<void>) => void;
    afterEach?: (fn: () => void | Promise<void>) => void;
    afterAll?: (fn: () => void | Promise<void>) => void;
    expect?: { getState?: () => { testPath?: string; currentTestName?: string } };
};

if (jestGlobals.beforeEach && jestGlobals.afterEach && jestGlobals.expect?.getState) {
    installJestLifecycle({
        beforeEach: jestGlobals.beforeEach,
        afterEach: jestGlobals.afterEach,
        afterAll: jestGlobals.afterAll,
        getState: () => jestGlobals.expect?.getState?.() ?? {},
    });
}
