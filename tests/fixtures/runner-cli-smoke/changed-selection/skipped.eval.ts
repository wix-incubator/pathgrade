import { describe, it } from 'vitest';
import type { PathgradeMeta } from '@wix/pathgrade';

export const __pathgradeMeta: PathgradeMeta = {
    deps: ['src/skipped.ts'],
};

describe('changed selection smoke skipped eval', () => {
    it('would fail if changed selection ran it', () => {
        throw new Error('this eval should not be selected');
    });
});
