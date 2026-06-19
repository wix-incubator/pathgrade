import { describe, expect, it } from 'vitest';
import {
    getCurrentCaseContext,
    runWithCaseContext,
    type CaseContext,
} from '../src/sdk/case-context.js';

const caseA: CaseContext = {
    caseId: 'case-a',
    caseName: 'does one thing',
    filePath: '/evals/sample.eval.ts',
    scope: 'runner-case',
};

const sharedFile: CaseContext = {
    caseId: 'file:/evals/sample.eval.ts',
    caseName: 'sample.eval.ts',
    filePath: '/evals/sample.eval.ts',
    scope: 'runner-suite-shared',
};

describe('case context', () => {
    it('returns an explicit empty state outside an adapter-installed scope', () => {
        expect(getCurrentCaseContext()).toEqual({ status: 'empty' });
    });

    it('installs plain runner case context for a bounded async scope', async () => {
        await expect(runWithCaseContext(caseA, async () => getCurrentCaseContext())).resolves.toEqual({
            status: 'active',
            context: caseA,
        });

        expect(getCurrentCaseContext()).toEqual({ status: 'empty' });
    });

    it('supports runner-suite/shared scope without inventing manual ambient context', async () => {
        await expect(runWithCaseContext(sharedFile, async () => getCurrentCaseContext())).resolves.toEqual({
            status: 'active',
            context: sharedFile,
        });
    });

    it('restores nested scopes in the correct order', async () => {
        const seen: unknown[] = [];

        await runWithCaseContext(sharedFile, async () => {
            seen.push(getCurrentCaseContext());
            await runWithCaseContext(caseA, async () => {
                seen.push(getCurrentCaseContext());
            });
            seen.push(getCurrentCaseContext());
        });

        expect(seen).toEqual([
            { status: 'active', context: sharedFile },
            { status: 'active', context: caseA },
            { status: 'active', context: sharedFile },
        ]);
        expect(getCurrentCaseContext()).toEqual({ status: 'empty' });
    });

    it('isolates overlapping async scopes from one another', async () => {
        const caseB: CaseContext = {
            caseId: 'case-b',
            caseName: 'does another thing',
            filePath: '/evals/sample.eval.ts',
            scope: 'runner-case',
        };
        let releaseA!: () => void;
        let releaseB!: () => void;

        const taskA = runWithCaseContext(caseA, async () => {
            await new Promise<void>((resolve) => { releaseA = resolve; });
            return getCurrentCaseContext();
        });
        const taskB = runWithCaseContext(caseB, async () => {
            await new Promise<void>((resolve) => { releaseB = resolve; });
            return getCurrentCaseContext();
        });

        releaseB();
        await expect(taskB).resolves.toEqual({ status: 'active', context: caseB });

        releaseA();
        await expect(taskA).resolves.toEqual({ status: 'active', context: caseA });
        expect(getCurrentCaseContext()).toEqual({ status: 'empty' });
    });
});
