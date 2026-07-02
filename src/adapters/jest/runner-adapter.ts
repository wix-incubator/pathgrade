import { normalizeJestRunResults, type JestAggregatedResult } from './results.js';
import {
    discoverPathgradeEvalFiles,
    type PathgradeTestMeta,
    AdapterInvocationInput,
    RunnerAdapter,
} from '@wix/pathgrade/adapter-kit';

interface JestRunNative {
    results?: JestAggregatedResult;
    metadataByCaseId?: Map<string, PathgradeTestMeta[]>;
}

export function createJestAdapter(options: JestRunNative = {}): RunnerAdapter {
    return {
        name: 'jest',
        async discover(input) {
            const include = input.include ?? ['**/*.eval.ts'];
            const exclude = input.exclude ?? [];
            const files = discoverPathgradeEvalFiles({
                cwd: input.cwd,
                include,
                exclude,
            });

            return {
                units: files.map(file => ({
                    id: file,
                    displayName: file,
                    sourceRef: file,
                    native: { file, cwd: input.cwd },
                })),
            };
        },
        async invoke(input: AdapterInvocationInput) {
            return {
                adapterName: this.name,
                status: input.signal?.aborted ? 'cancelled' : 'completed',
                exitCode: input.signal?.aborted ? 1 : 0,
                native: options,
            };
        },
        async collectNormalizedRunSnapshot(run) {
            const native = readJestRunNative(run);
            return normalizeJestRunResults({
                run,
                results: native.results ?? { testResults: [] },
                metadataByCaseId: native.metadataByCaseId,
            });
        },
    };
}

export function createPathgradeAdapter(): RunnerAdapter {
    return createJestAdapter();
}

function readJestRunNative(run: { native?: unknown }): JestRunNative {
    if (typeof run.native === 'object' && run.native !== null) {
        return run.native as JestRunNative;
    }
    return {};
}
