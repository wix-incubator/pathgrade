import { describe, it, expect } from 'vitest';

import { DEFAULT_COPY_IGNORE, createCopyFilter } from '../src/providers/copy-filter.js';
import { DEFAULT_COPY_IGNORE as PUBLIC_DEFAULT_COPY_IGNORE } from '../src/sdk/index.js';

describe('copy-filter', () => {
    describe('DEFAULT_COPY_IGNORE', () => {
        it('includes standard junk patterns', () => {
            expect(DEFAULT_COPY_IGNORE).toContain('node_modules');
            expect(DEFAULT_COPY_IGNORE).toContain('.git');
            expect(DEFAULT_COPY_IGNORE).toContain('dist');
            expect(DEFAULT_COPY_IGNORE).toContain('.DS_Store');
            expect(DEFAULT_COPY_IGNORE).toContain('__pycache__');
            expect(DEFAULT_COPY_IGNORE).toContain('npm-debug.log*');
            expect(DEFAULT_COPY_IGNORE).toContain('yarn-debug.log*');
            expect(DEFAULT_COPY_IGNORE).toContain('yarn-error.log*');
        });

        it('is re-exported from the public API (src/sdk/index)', () => {
            expect(PUBLIC_DEFAULT_COPY_IGNORE).toBe(DEFAULT_COPY_IGNORE);
        });

        it('is a frozen array (immutable)', () => {
            expect(() => {
                (DEFAULT_COPY_IGNORE as string[]).push('extra');
            }).toThrow();
        });
    });

    describe('createCopyFilter', () => {
        it('returns a function', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(typeof filter).toBe('function');
        });

        it('allows regular files through', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/src/index.ts')).toBe(true);
            expect(filter('/project/README.md')).toBe(true);
            expect(filter('/project/package.json')).toBe(true);
        });

        it('filters node_modules directory', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/node_modules')).toBe(false);
            expect(filter('/project/node_modules/')).toBe(false);
        });

        it('filters .git directory', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/.git')).toBe(false);
        });

        it('filters dist directory', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/dist')).toBe(false);
        });

        it('filters .DS_Store files', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/.DS_Store')).toBe(false);
            expect(filter('/project/src/.DS_Store')).toBe(false);
        });

        it('filters __pycache__ directory', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/__pycache__')).toBe(false);
        });

        it('filters glob patterns like npm-debug.log*', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/npm-debug.log')).toBe(false);
            expect(filter('/project/npm-debug.log.12345')).toBe(false);
        });

        it('filters yarn-debug.log* and yarn-error.log*', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/yarn-debug.log')).toBe(false);
            expect(filter('/project/yarn-error.log')).toBe(false);
            expect(filter('/project/yarn-error.log.gz')).toBe(false);
        });

        it('filters nested occurrences at any depth', () => {
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            expect(filter('/project/src/vendor/node_modules')).toBe(false);
            expect(filter('/project/deep/nested/.git')).toBe(false);
            expect(filter('/project/sub/dist')).toBe(false);
        });

        it('allows the root source directory through', () => {
            // The root path itself should always pass (fs.copy passes it as the first call)
            const filter = createCopyFilter(DEFAULT_COPY_IGNORE);
            // A root directory won't match any ignore pattern
            expect(filter('/project')).toBe(true);
        });

        it('uses custom ignore list, replacing defaults entirely', () => {
            const filter = createCopyFilter(['*.log', 'build']);
            // node_modules should pass since defaults are replaced
            expect(filter('/project/node_modules')).toBe(true);
            // Custom patterns should filter
            expect(filter('/project/app.log')).toBe(false);
            expect(filter('/project/build')).toBe(false);
        });

        it('returns a pass-all filter when ignore list is empty', () => {
            const filter = createCopyFilter([]);
            expect(filter('/project/node_modules')).toBe(true);
            expect(filter('/project/.git')).toBe(true);
            expect(filter('/project/dist')).toBe(true);
        });

        it('silently ignores invalid glob patterns', () => {
            // Invalid globs should not crash; they just don't match anything
            const filter = createCopyFilter(['node_modules', '[invalid']);
            expect(filter('/project/node_modules')).toBe(false);
            expect(filter('/project/src/index.ts')).toBe(true);
        });

        it('matches against basename only, not the full path', () => {
            const filter = createCopyFilter(['src']);
            // 'src' should match a directory named 'src'
            expect(filter('/project/src')).toBe(false);
            // But not a file that has 'src' in a parent path segment
            expect(filter('/project/resources/file.ts')).toBe(true);
        });
    });
});
