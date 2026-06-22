import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const forbiddenRunnerImport = /from\s+['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?|(?:\.\.\/)+pathgrade(?:\.[^'"]*)?)['"]|import\s*['"](?:vitest|vitest\/config|vitest\/node|@wix\/pathgrade\/plugin|(?:\.\.\/)+plugin(?:\/[^'"]*)?|(?:\.\.\/)+reporters(?:\/[^'"]*)?|(?:\.\.\/)+commands(?:\/[^'"]*)?|(?:\.\.\/)+pathgrade(?:\.[^'"]*)?)['"]/;

describe('lifecycle core dependency boundary', () => {
    it('keeps the core independent from Vitest, plugin, reporter, CLI, and artifact-writing modules', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/sdk/lifecycle.ts'), 'utf8');

        expect(
            source,
            'lifecycle core must remain SDK-adjacent and runner-neutral',
        ).not.toMatch(forbiddenRunnerImport);
    });

    it('keeps SDK agent lifecycle code independent from plugin lifecycle', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/sdk/agent.ts'), 'utf8');

        expect(
            source,
            'SDK agent code should depend on lifecycle core, not the Vitest plugin lifecycle module',
        ).not.toMatch(/from\s+['"](?:\.\.\/)+plugin\/lifecycle(?:\.js)?['"]/);
        expect(source).toContain("from './lifecycle.js'");
    });
});
