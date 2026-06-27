import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('affected selection dependency boundary', () => {
    it('keeps affected command defaults owned by Pathgrade instead of Vitest config', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/commands/affected.ts'), 'utf8');

        expect(source).not.toMatch(/from\s+['"]vitest\/config['"]/);
        expect(source).not.toContain('configDefaults');
    });
});
