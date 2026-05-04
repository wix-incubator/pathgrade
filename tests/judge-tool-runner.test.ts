import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsExtra from 'fs-extra';
import { runJudgeWithTools } from '../src/sdk/judge-tool-runner.js';
import type { CallWithToolsResult, ToolCapableLLMPort, ToolUseBlock } from '../src/utils/llm-types.js';
import type { JudgeScorer, ScorerContext } from '../src/sdk/types.js';
import type { CommandResult } from '../src/types.js';

function makeCtx(workspace: string): ScorerContext {
    return {
        workspace,
        log: [],
        transcript: '[User] Hi\n\n[Agent] Done',
        toolEvents: [],
        runCommand: async (): Promise<CommandResult> => ({ stdout: '', stderr: '', exitCode: 0 }),
        artifacts: {
            list: () => [],
            read: async () => '',
            latest: async () => null,
        },
    };
}

function scripted(results: CallWithToolsResult[]): { llm: ToolCapableLLMPort; calls: unknown[][] } {
    const calls: unknown[][] = [];
    let i = 0;
    const llm: ToolCapableLLMPort = {
        async call() { throw new Error('unused in tool-use tests'); },
        async callWithTools(messages, opts) {
            calls.push([messages, opts]);
            const next = results[i++];
            if (!next) throw new Error(`scripted: no more responses (call ${i})`);
            return next;
        },
    };
    return { llm, calls };
}

function tool(id: string, name: string, input: unknown): ToolUseBlock {
    return { type: 'tool_use', id, name, input: input as Record<string, unknown> };
}

function final(text: string): CallWithToolsResult {
    return { kind: 'final', text, inputTokens: 10, outputTokens: 5 };
}

function toolUse(blocks: ToolUseBlock[], text?: string): CallWithToolsResult {
    return { kind: 'tool_use', blocks, text, inputTokens: 10, outputTokens: 5 };
}

describe('runJudgeWithTools — wrapper semantics (retry + mapping)', () => {
    let workspace: string;

    beforeEach(async () => {
        workspace = await fs.realpath(
            await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-runner-')),
        );
        await fs.writeFile(path.join(workspace, 'spec.md'), '# Spec\n\nFR-1: do a thing');
    });

    afterEach(async () => {
        try { await fsExtra.remove(workspace); } catch {}
    });

    const scorer: JudgeScorer = {
        type: 'judge',
        name: 'spec-quality',
        weight: 1,
        rubric: 'Rate the spec quality',
        tools: ['readFile'],
    };

    it('retries once on invalid_score when scorer.retry is true', async () => {
        const scorerRetry: JudgeScorer = { ...scorer, retry: true };
        const { llm } = scripted([
            final('garbage, not json'),
            final('```json\n{"score": 0.9, "details": "recovered"}\n```'),
        ]);
        const result = await runJudgeWithTools(scorerRetry, makeCtx(workspace), llm);
        expect(result.entry.status).toBe('ok');
        expect(result.entry.score).toBe(0.9);
    });

    it('retries on llm_refused (empty final) up to the configured count', async () => {
        const scorerRetry: JudgeScorer = { ...scorer, retry: 2 };
        const { llm, calls } = scripted([
            final(''),
            final(''),
            final('```json\n{"score": 0.6, "details": "third-time lucky"}\n```'),
        ]);
        const result = await runJudgeWithTools(scorerRetry, makeCtx(workspace), llm);
        expect(result.entry.status).toBe('ok');
        expect(result.entry.score).toBe(0.6);
        expect(calls).toHaveLength(3);
    });

    it('does NOT retry on max_rounds even when retry is configured', async () => {
        const scorerRetry: JudgeScorer = { ...scorer, retry: 5 };
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'readFile', { path: 'spec.md' })]),
        ]);
        const result = await runJudgeWithTools(scorerRetry, makeCtx(workspace), llm, { maxRounds: 1 });
        expect(result.entry.errorCode).toBe('max_rounds');
        expect(calls).toHaveLength(1);
    });

    it('does NOT retry on tool_error_unrecoverable even when retry is configured', async () => {
        const scorerRetry: JudgeScorer = { ...scorer, retry: 5 };
        const { llm, calls } = scripted([
            toolUse([tool('t1', 'runCommand', { cmd: 'rm' })]),
        ]);
        const result = await runJudgeWithTools(scorerRetry, makeCtx(workspace), llm);
        expect(result.entry.errorCode).toBe('tool_error_unrecoverable');
        expect(calls).toHaveLength(1);
    });

    it('HTTP errors from callWithTools surface as tool_error_unrecoverable', async () => {
        const llm: ToolCapableLLMPort = {
            call: async () => { throw new Error('unused'); },
            callWithTools: async () => {
                throw new Error('Anthropic API error (429): { "type": "error", "error": { "type": "rate_limit_error" } }');
            },
        };
        const result = await runJudgeWithTools(scorer, makeCtx(workspace), llm);
        expect(result.entry.errorCode).toBe('tool_error_unrecoverable');
        expect(result.entry.details).toMatch(/429|rate_limit/);
    });
});
