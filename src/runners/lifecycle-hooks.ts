import { lifecycleCore } from '../sdk/lifecycle.js';
import { runWithCaseContext, type CaseContext } from '../sdk/case-context.js';
import type { AdapterCaseContext, AdapterLifecycleHooks } from './adapter.js';

export function createRunnerLifecycleHooks(): AdapterLifecycleHooks {
    return {
        onResult: event => lifecycleCore.recordResult(event.result, event.agent),
        withCaseContext: (context, run) => runWithCaseContext(toCaseContext(context), run),
        flushCase: caseId => lifecycleCore.flushCase({ caseId }),
        cleanupRun: () => lifecycleCore.cleanupAll(),
    };
}

function toCaseContext(context: AdapterCaseContext): CaseContext {
    return {
        caseId: context.caseId,
        caseName: context.caseName,
        filePath: context.filePath ?? context.sourceRef ?? '',
        scope: context.scope,
    };
}
