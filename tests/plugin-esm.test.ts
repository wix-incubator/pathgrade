import { describe, it, expect } from 'vitest';
import { pathgrade } from 'pathgrade/plugin';

describe('ESM plugin integration', () => {
    it('returns valid config with setupFiles when imported as ESM', () => {
        const plugin = pathgrade({ timeout: 300 });

        expect(plugin.name).toBe('pathgrade');

        const config = plugin.config();

        expect(config.test.setupFiles).toBeDefined();
        expect(config.test.setupFiles.length).toBeGreaterThan(0);
        expect(config.test.include).toEqual(['**/*.eval.ts']);
        expect(config.test.testTimeout).toBe((300 + 30) * 1000);
    });
});
