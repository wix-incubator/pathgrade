import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsExtra from 'fs-extra';
import { runJudgeWithTools } from '../src/sdk/judge-tool-runner.js';
import { anthropicProvider } from '../src/utils/llm-providers/anthropic.js';
import type { JudgeScorer, ScorerContext } from '../src/sdk/types.js';
import type { ToolCapableLLMPort } from '../src/utils/llm-types.js';
import type { CommandResult } from '../src/types.js';

/** Env-gated: runs only when APP_ANTHROPIC_API_KEY is set. */
describe.runIf(!!process.env.APP_ANTHROPIC_API_KEY)(
    'runJudgeWithTools against real Anthropic',
    () => {
        it('scores a spec fixture in a sensible band using readFile', async () => {
            const workspace = await fs.realpath(
                await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-e2e-')),
            );
            try {
                await fs.writeFile(
                    path.join(workspace, 'spec.md'),
                    [
                        '# Product Spec',
                        '',
                        '## Intent Hierarchy',
                        '- Primary: help users grade agents',
                        '',
                        '## Functional Requirements',
                        '- FR-1: grade with rubric',
                        '- FR-2: collect transcripts',
                    ].join('\n'),
                );

                const scorer: JudgeScorer = {
                    type: 'judge',
                    name: 'spec-quality',
                    weight: 1,
                    rubric: [
                        'Read `spec.md` and score on:',
                        '1. Does it have an Intent Hierarchy section? (0.5 of total)',
                        '2. Does it list at least two Functional Requirements? (0.5 of total)',
                    ].join('\n'),
                    tools: ['readFile'],
                    model: 'claude-haiku-4-5-20251001',
                };

                const ctx: ScorerContext = {
                    workspace,
                    log: [],
                    transcript: '[User] write a spec\n\n[Agent] done',
                    toolEvents: [],
                    runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
                    artifacts: {
                        list: () => [],
                        read: async () => '',
                        latest: async () => null,
                    },
                };

                const llm = anthropicProvider as unknown as ToolCapableLLMPort;
                const result = await runJudgeWithTools(scorer, ctx, llm);
                expect(result.entry.status).toBe('ok');
                expect(result.entry.score).toBeGreaterThanOrEqual(0.75);
                expect(result.entry.score).toBeLessThanOrEqual(1.0);
                expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
                expect(result.toolCalls.every((c) => c.name === 'readFile')).toBe(true);
            } finally {
                await fsExtra.remove(workspace).catch(() => {});
            }
        }, 60_000);
    },
);
