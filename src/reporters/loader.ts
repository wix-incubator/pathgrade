import fs from 'fs-extra';
import * as path from 'path';
import type { EvalReport } from '../types.js';

export interface LoadedReport extends EvalReport {
    file: string;
    timestamp?: string;
}

async function hydrateTraces(report: LoadedReport, traceFile: string, resolved: string): Promise<void> {
    const tracePath = path.resolve(resolved, traceFile);
    if (!await fs.pathExists(tracePath)) return;
    const traceTrials = await fs.readJSON(tracePath);
    if (!Array.isArray(traceTrials) || !Array.isArray(report.trials)) return;
    report.trials = report.trials.map((t: any, i: number) => ({ ...t, ...traceTrials[i] }));
}

export async function loadReports(
    resultsDir: string,
    opts?: { skipTraces?: boolean },
): Promise<LoadedReport[]> {
    const resolved = path.resolve(resultsDir);
    const files = (await fs.readdir(resolved))
        .filter(f => f.endsWith('.json'))
        .reverse();

    const results: LoadedReport[] = [];
    for (const file of files) {
        try {
            const raw = await fs.readJSON(path.join(resolved, file));
            if (!raw.version || !Array.isArray(raw.groups)) {
                results.push({ file, ...raw });
                continue;
            }
            for (const group of raw.groups) {
                const report: LoadedReport = { file, timestamp: raw.timestamp, ...group };
                if (!opts?.skipTraces && group.trace_file) {
                    await hydrateTraces(report, group.trace_file, resolved);
                }
                results.push(report);
            }
        } catch { /* skip malformed */ }
    }
    return results;
}
