import * as path from 'path';

export function getPathgradeDir(projectDir: string): string {
    return path.join(projectDir, '.pathgrade');
}

export function getResultsDir(projectDir: string, baseDir?: string): string {
    if (baseDir) {
        return path.join(baseDir, path.basename(projectDir), 'results');
    }
    return getPathgradeDir(projectDir);
}
