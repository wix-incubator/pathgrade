/**
 * Tool-using judge demo — shows how `judge({ tools: [...] })` lets the judge
 * LLM read workspace artifacts directly instead of the eval author
 * pre-computing probes and passing them via `input`.
 *
 * Migration pattern:
 *
 *   // Before (hand-rolled probe + input):
 *   const sections = missingSpecSections(workspace);
 *   judge('spec-sections', {
 *     rubric: 'Does the spec contain all required sections?',
 *     input: { missing_sections: sections },
 *   });
 *
 *   // After (judge reads the file itself):
 *   judge('spec-sections', {
 *     rubric: 'Read artifacts/spec.md and grade whether it has Intent Hierarchy, Functional Requirements, and API Surface sections.',
 *     tools: ['readFile', 'grep'],
 *   });
 *
 * Run: npx vitest run --config examples/tool-judge-demo/vitest.config.mts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { judge, check, createAgent, evaluate } from '@wix/pathgrade';
import type { PathgradeMeta } from '@wix/pathgrade';

export const __pathgradeMeta: PathgradeMeta = {
    deps: ['examples/tool-judge-demo/**'],
};

const HAS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'spec.md');

describe.runIf(HAS_ANTHROPIC)('tool-judge-demo', () => {
    it('grades a spec via readFile + grep (no hand-rolled probes)', async () => {
        const agent = await createAgent({ agent: 'claude', timeout: 120 });
        // Pre-populate the workspace with the fixture spec. A real eval would
        // have the agent produce this file; we short-circuit the agent turn
        // to focus the demo on the tool-judge.
        fs.mkdirSync(path.join(agent.workspace, 'artifacts'), { recursive: true });
        fs.copyFileSync(fixturePath, path.join(agent.workspace, 'artifacts', 'spec.md'));

        const result = await evaluate(agent, [
            check('spec-exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'artifacts', 'spec.md')),
            ),
            judge('spec-structure', {
                rubric: [
                    'Read `artifacts/spec.md`. Score 1.0 if it contains all three of:',
                    '  1. "Intent Hierarchy" section',
                    '  2. "Functional Requirements" section',
                    '  3. "API Surface" section',
                    'Score 0.33 per section present. 0.0 if none.',
                ].join('\n'),
                tools: ['readFile'],
                model: 'claude-haiku-4-5-20251001',
            }),
            judge('fr-count', {
                rubric: [
                    'Use grep to count lines starting with `- FR-` in `artifacts/spec.md`.',
                    'Score 1.0 if there are at least 3 FR entries, 0.5 for 2, 0.0 for fewer.',
                ].join('\n'),
                tools: ['grep', 'readFile'],
                model: 'claude-haiku-4-5-20251001',
            }),
        ]);

        expect(result.score).toBeGreaterThanOrEqual(0.75);
    }, 180_000);
});
