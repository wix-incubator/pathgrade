/**
 * Copy filter for workspace and skill directory copies.
 *
 * Filters out junk directories and files (node_modules, .git, dist, etc.)
 * when copying workspace/skill directories into the sandbox.
 */
import * as path from 'path';
import picomatch from 'picomatch';

/**
 * Default ignore patterns applied when copying workspace and skill directories.
 * Matches against the basename (filename or directory name) of each entry.
 *
 * - Plain names (no wildcards) match exact directory/file names at any depth.
 * - Glob patterns (with wildcards) match filenames at any depth.
 */
export const DEFAULT_COPY_IGNORE: readonly string[] = Object.freeze([
    'node_modules',
    '.git',
    'dist',
    '.DS_Store',
    '__pycache__',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
]);

/**
 * Creates a filter function suitable for use with `fs.copy()`.
 *
 * The filter matches ignore patterns against the **basename** of each path.
 * Returns `true` to include the file/directory, `false` to exclude it.
 *
 * @param ignorePatterns - Array of patterns to filter. Replaces defaults entirely.
 *   Pass `[]` to disable filtering. Invalid glob patterns are silently ignored.
 */
export function createCopyFilter(ignorePatterns: readonly string[]): (src: string) => boolean {
    if (ignorePatterns.length === 0) {
        return () => true;
    }

    // Build matchers from the patterns, silently skipping invalid ones
    const matchers: picomatch.Matcher[] = [];
    for (const pattern of ignorePatterns) {
        try {
            matchers.push(picomatch(pattern));
        } catch {
            // Invalid glob pattern: silently ignore per PRD
        }
    }

    if (matchers.length === 0) {
        return () => true;
    }

    return (src: string): boolean => {
        const basename = path.basename(src);
        // Don't filter if basename is empty (shouldn't happen, but be safe)
        if (!basename) {
            return true;
        }
        // Check if any matcher matches the basename
        for (const matcher of matchers) {
            if (matcher(basename)) {
                return false;
            }
        }
        return true;
    };
}
