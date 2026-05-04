/**
 * `pathgrade preview` command.
 *
 * Opens the CLI or browser results viewer.
 */
import { runCliPreview } from '../reporters/cli.js';
import { runBrowserPreview } from '../reporters/browser.js';
import { getResultsDir } from '../reporters/results-path.js';

export interface PreviewOptions {
    last?: number;
    filter?: string;
}

export async function runPreview(dir: string, mode: 'cli' | 'browser', outputDir?: string, opts?: PreviewOptions) {
    const resultsDir = getResultsDir(dir, outputDir);

    if (mode === 'browser') {
        await runBrowserPreview(resultsDir);
    } else {
        await runCliPreview(resultsDir, opts);
    }
}
