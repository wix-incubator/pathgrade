import '../src/plugin/setup.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    check,
    createAgent,
    evaluate,
    type Agent,
    type PathgradeTestMeta,
} from '../src/sdk/index.js';
import { getCurrentCaseContext } from '../src/sdk/case-context.js';

const moduleScopeContext = getCurrentCaseContext();
const moduleScopeAgent = createAgent({});
let beforeAllContext: ReturnType<typeof getCurrentCaseContext>;
let beforeAllAgent: Agent;
const flushedMeta = new Map<string, PathgradeTestMeta[] | undefined>();

describe('Vitest case context integration', () => {
    beforeAll(async () => {
        beforeAllContext = getCurrentCaseContext();
        beforeAllAgent = await createAgent({});
    });

    it('makes neutral runner-case context visible inside the user test body', () => {
        const current = getCurrentCaseContext();

        expect(current.status).toBe('active');
        if (current.status !== 'active') return;

        expect(current.context.scope).toBe('runner-case');
        expect(current.context.caseId).toBeTruthy();
        expect(current.context.caseName).toBe('makes neutral runner-case context visible inside the user test body');
        expect(current.context.filePath.endsWith('tests/vitest-case-context.test.ts')).toBe(true);
    });

    it('makes runner-suite/shared context visible at module scope and beforeAll', () => {
        for (const current of [moduleScopeContext, beforeAllContext]) {
            expect(current.status).toBe('active');
            if (current.status !== 'active') return;

            expect(current.context.scope).toBe('runner-suite-shared');
            expect(current.context.caseId).toContain('tests/vitest-case-context.test.ts');
            expect(current.context.caseName).toBe('vitest-case-context.test.ts');
            expect(current.context.filePath.endsWith('tests/vitest-case-context.test.ts')).toBe(true);
        }
    });

    it('attributes module-scope shared agent evaluations to the active runner case', async ({ task, onTestFinished }) => {
        onTestFinished(() => {
            flushedMeta.set(task.name, task.meta.pathgrade);
        });
        const agent = await moduleScopeAgent;

        await evaluate(agent, [check('module agent is evaluable', () => true)]);
    });

    it('does not let a later case steal the module-scope shared agent result', async () => {
        const previous = flushedMeta.get('attributes module-scope shared agent evaluations to the active runner case');

        expect(previous).toHaveLength(1);
        expect(previous?.[0].scorers[0].name).toBe('module agent is evaluable');
    });

    it('attributes beforeAll shared agent evaluations to the active runner case', async ({ task, onTestFinished }) => {
        onTestFinished(() => {
            flushedMeta.set(task.name, task.meta.pathgrade);
        });
        await evaluate(beforeAllAgent, [check('beforeAll agent is evaluable', () => true)]);
    });

    it('does not let a later case steal the beforeAll shared agent result', async () => {
        const previous = flushedMeta.get('attributes beforeAll shared agent evaluations to the active runner case');

        expect(previous).toHaveLength(1);
        expect(previous?.[0].scorers[0].name).toBe('beforeAll agent is evaluable');
    });
});
