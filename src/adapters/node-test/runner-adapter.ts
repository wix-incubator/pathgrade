import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import { discoverPathgradeEvalFiles } from '../../evals/discovery.js';
import type { ReportCaseInput } from '../../reporting/types.js';
import { buildNormalizedRunSnapshotFromReportGroups } from '../../runners/model-builders.js';
import type {
    AdapterInvocationInput,
    AdapterRunHandle,
    RunnerAdapter,
} from '../../runners/adapter.js';

interface NodeTestRunNative {
    resultsPath: string;
}

export function createNodeTestAdapter(): RunnerAdapter {
    return {
        name: 'node-test',
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
        async invoke(input: AdapterInvocationInput): Promise<AdapterRunHandle> {
            const resultsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-node-test-'));
            const resultsPath = path.join(resultsDir, 'cases.json');
            const cwd = readDiscoveredCwd(input.discovered.units[0]?.native) ?? process.cwd();
            const files = input.discovered.units
                .map(unit => unit.sourceRef)
                .filter((sourceRef): sourceRef is string => typeof sourceRef === 'string');

            if (files.length === 0) {
                await fs.writeJson(resultsPath, []);
                return {
                    adapterName: this.name,
                    status: 'completed',
                    exitCode: 0,
                    native: { resultsPath } satisfies NodeTestRunNative,
                };
            }

            const exitCode = await spawnNodeTest({
                testCwd: cwd,
                files,
                argv: input.argv,
                env: {
                    ...input.env,
                    PATHGRADE_NODE_TEST_RESULTS: resultsPath,
                    PATHGRADE_NODE_TEST_CWD: cwd,
                },
            });

            return {
                adapterName: this.name,
                status: input.signal?.aborted ? 'cancelled' : (exitCode === 0 ? 'completed' : 'failed'),
                exitCode,
                native: { resultsPath } satisfies NodeTestRunNative,
            };
        },
        async collectNormalizedRunSnapshot(run) {
            const native = readNodeTestRunNative(run);
            const cases = await readCases(native.resultsPath);
            const groupMap = new Map<string, ReportCaseInput[]>();

            for (const testCase of cases) {
                const groupName = testCase.groupName ?? testCase.filePath ?? testCase.sourceRef ?? 'node-test';
                if (!groupMap.has(groupName)) groupMap.set(groupName, []);
                groupMap.get(groupName)!.push(testCase);
            }

            return buildNormalizedRunSnapshotFromReportGroups(
                run,
                Array.from(groupMap.entries()).map(([groupName, groupedCases]) => ({
                    groupName,
                    cases: groupedCases,
                })),
            );
        },
    };
}

async function spawnNodeTest(input: {
    testCwd: string;
    files: string[];
    argv: string[];
    env: NodeJS.ProcessEnv;
}): Promise<number> {
    const tsxLoader = import.meta.resolve('tsx');
    const args = [
        '--import',
        tsxLoader,
        '--test',
        ...input.files,
        ...input.argv,
    ];

    return await new Promise(resolve => {
        const child = spawn(process.execPath, args, {
            cwd: input.testCwd,
            env: input.env,
            stdio: 'inherit',
        });
        child.on('close', code => resolve(code ?? 0));
        child.on('error', () => resolve(1));
    });
}

function readNodeTestRunNative(run: AdapterRunHandle): NodeTestRunNative {
    if (
        typeof run.native === 'object'
        && run.native !== null
        && typeof (run.native as { resultsPath?: unknown }).resultsPath === 'string'
    ) {
        return run.native as NodeTestRunNative;
    }
    return { resultsPath: '' };
}

async function readCases(resultsPath: string): Promise<ReportCaseInput[]> {
    if (!resultsPath || !(await fs.pathExists(resultsPath))) return [];
    return await fs.readJson(resultsPath) as ReportCaseInput[];
}

function readDiscoveredCwd(native: unknown): string | undefined {
    if (
        typeof native === 'object'
        && native !== null
        && typeof (native as { cwd?: unknown }).cwd === 'string'
    ) {
        return (native as { cwd: string }).cwd;
    }
    return undefined;
}
