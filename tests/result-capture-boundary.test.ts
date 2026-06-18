import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('result-capture dependency boundary', () => {
    it('stays independent from Vitest, plugin lifecycle, and reporters', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/sdk/result-capture.ts'), 'utf8');
        const forbiddenImport = /from\s+['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?)['"]|import\s*['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?)['"]/;

        expect(source, 'result capture must stay SDK-adjacent and runner-neutral').not.toMatch(forbiddenImport);
    });
});
