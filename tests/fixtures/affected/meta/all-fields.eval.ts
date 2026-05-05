throw new Error('do not execute');

import type { PathgradeMeta } from '@wix/pathgrade';

export const __pathgradeMeta: PathgradeMeta = {
    deps: ['custom/**'],
    extraDeps: ['also/**'],
    alwaysRun: false,
};
