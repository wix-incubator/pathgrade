import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('diagnostics dependency boundary', () => {
    it('keeps diagnostics report construction independent from adapters, reporters, and CLI modules', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/sdk/diagnostics.ts'), 'utf8');
        const forbiddenImport = /from\s+['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?)['"]|import\s*['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?)['"]/;

        expect(
            source,
            'diagnostics report data and construction must stay SDK-adjacent and runner-neutral',
        ).not.toMatch(forbiddenImport);
    });
});
