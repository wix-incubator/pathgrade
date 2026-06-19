import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('case-context dependency boundary', () => {
    it('keeps neutral case context independent from Vitest, plugin lifecycle, reporters, and CLI modules', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/sdk/case-context.ts'), 'utf8');
        const forbiddenImport = /from\s+['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?)['"]|import\s*['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?)['"]/;

        expect(
            source,
            'Vitest translation belongs in adapter code; SDK-adjacent case context must stay runner-neutral.',
        ).not.toMatch(forbiddenImport);
    });
});
