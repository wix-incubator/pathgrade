import path from 'node:path';
import fs from 'fs-extra';
import type { ArtifactWriteResult, PathgradeReportBuildResult } from './types.js';

export async function writePathgradeArtifacts(
    artifactRoot: string,
    built: PathgradeReportBuildResult,
): Promise<ArtifactWriteResult> {
    await fs.ensureDir(path.join(artifactRoot, 'traces'));

    const gitignorePath = path.join(artifactRoot, '.gitignore');
    if (!(await fs.pathExists(gitignorePath))) {
        await fs.writeFile(gitignorePath, '*\n');
    }

    const traceFiles: string[] = [];
    for (const trace of built.traces) {
        await fs.writeJson(path.join(artifactRoot, trace.traceFile), trace.trials, { spaces: 2 });
        traceFiles.push(trace.traceFile);
    }

    const resultsPath = path.join(artifactRoot, 'results.json');
    await fs.writeJson(resultsPath, built.report, { spaces: 2 });

    return {
        resultsPath,
        traceFiles,
    };
}
