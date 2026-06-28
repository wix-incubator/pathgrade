import nodeTest from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { ReportCaseInput, ReportEvaluationInput } from '../../reporting/types.js';
import type { PathgradeTestMeta } from '../../sdk/types.js';
import { subscribeToEvalResults } from '../../sdk/result-capture.js';
import { createRunnerLifecycleHooks } from '../../runners/lifecycle-hooks.js';

type NodeTestFn = (t: TestContext) => unknown | Promise<unknown>;
type NodeTestOptions = Record<string, unknown>;

const lifecycle = createRunnerLifecycleHooks();
let subscribed = false;
let caseCounter = 0;

export function test(name: string, fn: NodeTestFn): void;
export function test(name: string, options: NodeTestOptions, fn: NodeTestFn): void;
export function test(name: string, optionsOrFn: NodeTestOptions | NodeTestFn, maybeFn?: NodeTestFn): void {
    installResultCapture();

    const options = typeof optionsOrFn === 'function' ? undefined : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    const sourceRef = callerSourceRef();
    const caseId = `${sourceRef}:${name}:${++caseCounter}`;

    nodeTest(name, options as never, async (ctx) => {
        const startedAt = performance.now();
        let state: ReportCaseInput['state'] = 'passed';
        let thrown: unknown;

        try {
            await lifecycle.withCaseContext({
                caseId,
                caseName: name,
                filePath: sourceRef,
                sourceRef,
                runnerNativeId: caseId,
                scope: 'runner-case',
            }, async () => {
                await fn?.(ctx);
            });
        } catch (err) {
            state = 'failed';
            thrown = err;
        } finally {
            const evaluations = await lifecycle.flushCase(caseId);
            writeCase({
                caseId,
                name,
                state,
                runnerDurationMs: performance.now() - startedAt,
                sourceRef,
                filePath: sourceRef,
                groupName: sourceRef,
                runnerCaseId: caseId,
                evaluations: toReportEvaluations(evaluations),
            });
        }

        if (thrown) throw thrown;
    });
}

export default test;

export { createNodeTestAdapter } from './runner-adapter.js';
export { createNodeTestInvocationAdapter } from './invocation-adapter.js';

function installResultCapture(): void {
    if (subscribed) return;
    subscribed = true;
    subscribeToEvalResults(event => lifecycle.onResult(event), {
        owner: 'adapter',
        key: 'node-test-lifecycle',
    });
}

function toReportEvaluations(evaluations: PathgradeTestMeta[]): ReportEvaluationInput[] | undefined {
    if (evaluations.length === 0) return undefined;
    return evaluations.map(entry => ({
        score: entry.score,
        trial: entry.trial,
        diagnostics: entry.diagnostics,
    }));
}

function writeCase(testCase: ReportCaseInput): void {
    const resultsPath = process.env.PATHGRADE_NODE_TEST_RESULTS;
    if (!resultsPath) return;

    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    const existing = fs.existsSync(resultsPath)
        ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as ReportCaseInput[]
        : [];
    existing.push(testCase);
    fs.writeFileSync(resultsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function callerSourceRef(): string {
    const stack = new Error().stack ?? '';
    const cwd = realpath(process.env.PATHGRADE_NODE_TEST_CWD ?? process.cwd());

    for (const line of stack.split('\n')) {
        const match = line.match(/\(?((?:file:\/\/)?[^() ]+\.eval\.[cm]?[jt]s)(?::\d+)?(?::\d+)?\)?/);
        if (!match) continue;

        const raw = match[1];
        const abs = realpath(raw.startsWith('file://') ? fileURLToPath(raw) : raw);
        return path.relative(cwd, abs).replaceAll(path.sep, '/');
    }

    return 'node-test';
}

function realpath(value: string): string {
    try {
        return fs.realpathSync(value);
    } catch {
        return value;
    }
}
