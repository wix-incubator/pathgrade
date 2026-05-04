import { describe, it, expect } from 'vitest';
import { pathgrade } from '../src/plugin/index.js';

describe('pathgrade plugin exclude', () => {
    it('default exclude includes worktree patterns and vitest defaults', () => {
        const plugin = pathgrade();
        const config = plugin.config();

        expect(config.test.exclude).toContain('.worktrees/**');
        expect(config.test.exclude).toContain('worktrees/**');
        // Vitest defaults are preserved
        expect(config.test.exclude).toContain('**/node_modules/**');
        expect(config.test.exclude).toContain('**/.git/**');
    });

    it('user-provided exclude replaces defaults', () => {
        const plugin = pathgrade({ exclude: ['custom/**'] });
        const config = plugin.config();

        expect(config.test.exclude).toEqual(['custom/**']);
    });
});
