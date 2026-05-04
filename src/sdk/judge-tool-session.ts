import * as fs from 'fs/promises';
import type {
    CallWithToolsResult,
    ToolCapableLLMPort,
    ToolResultBlock,
    ToolSchema,
    ToolUseBlock,
    ToolUseMessage,
} from '../utils/llm-types.js';
import type { JudgeScorer, ScorerContext, TokenUsage } from './types.js';
import type { LogEntry } from '../types.js';
import { DEFAULT_TOOL_REGISTRY, type RegisteredTool } from './judge-tools.js';
import { buildToolUseJudgePrompt } from './judge-prompt-builder.js';
import { getErrorMessage } from './scorer-utils.js';

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export type JudgeErrorCode =
    | 'llm_refused'
    | 'max_rounds'
    | 'invalid_score'
    | 'tool_error_unrecoverable'
    | 'provider_not_supported';

export interface JudgeToolCallRecord {
    name: string;
    input: unknown;
    ok: boolean;
    bytes: number;
    errorMessage?: string;
}

export type ToolExecutor = (
    name: string,
    input: Record<string, unknown>,
    ctx: ScorerContext,
) => Promise<string>;

export interface JudgeSessionInput {
    scorer: JudgeScorer;
    ctx: ScorerContext;
    llm: ToolCapableLLMPort;
}

export interface JudgeSessionOptions {
    /** Overrides scorer.maxRounds. */
    maxRounds?: number;
    /** Per-tool-call timeout (ms). Default 10_000. */
    toolTimeoutMs?: number;
    /** Override tool execution dispatch; used by tests and future MCP-backed registries. */
    toolExecutor?: ToolExecutor;
    /** Override the tool registry; defaults to DEFAULT_TOOL_REGISTRY. */
    registry?: ReadonlyMap<string, RegisteredTool>;
    /** Push `judge_tool_call` entries into `ctx.log` as they happen. Default `true`. When `false`, entries are only returned in `SessionOutcome.logEntries`. */
    emitLogs?: boolean;
}

export type SessionOutcome =
    | {
        code: null;
        score: number;
        details: string;
        rounds: number;
        toolCalls: JudgeToolCallRecord[];
        tokenUsage: TokenUsage;
        logEntries: LogEntry[];
    }
    | {
        code: JudgeErrorCode;
        details: string;
        rounds: number;
        toolCalls: JudgeToolCallRecord[];
        tokenUsage: TokenUsage;
        logEntries: LogEntry[];
    };

export async function runJudgeSession(
    input: JudgeSessionInput,
    options: JudgeSessionOptions = {},
): Promise<SessionOutcome> {
    const { scorer, ctx, llm } = input;
    const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: JudgeToolCallRecord[] = [];
    const logEntries: LogEntry[] = [];
    const emitLogs = options.emitLogs ?? true;

    if (typeof llm.callWithTools !== 'function') {
        return makeOutcome(tokenUsage, toolCalls, logEntries, 0, {
            code: 'provider_not_supported',
            details:
                'The active LLM provider does not support tool-use judges (no callWithTools). Set ANTHROPIC_API_KEY to use the Anthropic HTTP provider, or remove `tools` from this judge.',
        });
    }

    try {
        await fs.access(ctx.workspace);
    } catch {
        return makeOutcome(tokenUsage, toolCalls, logEntries, 0, {
            code: 'tool_error_unrecoverable',
            details: `Workspace does not exist: ${ctx.workspace}`,
        });
    }

    const registry = options.registry ?? DEFAULT_TOOL_REGISTRY;
    const allowed = new Set(scorer.tools ?? []);
    const toolSchemas: ToolSchema[] = (scorer.tools ?? []).map((n) => registry.get(n)!.schema);
    const maxRounds = options.maxRounds ?? scorer.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

    const { system, user } = buildToolUseJudgePrompt(scorer, ctx);
    const messages: ToolUseMessage[] = [
        { role: 'user', content: user },
    ];

    let rounds = 0;
    while (rounds < maxRounds) {
        rounds++;
        let response: CallWithToolsResult;
        try {
            response = await llm.callWithTools(messages, {
                system,
                tools: toolSchemas,
                model: scorer.model,
                cacheControl: scorer.cacheControl,
            });
        } catch (err) {
            return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
                code: 'tool_error_unrecoverable',
                details: getErrorMessage(err),
            });
        }
        tokenUsage.inputTokens += response.inputTokens ?? 0;
        tokenUsage.outputTokens += response.outputTokens ?? 0;

        if (response.kind === 'final') {
            if (!response.text.trim()) {
                return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
                    code: 'llm_refused',
                    details: 'LLM returned empty response with no tool calls',
                });
            }
            const parsed = parseFinalScore(response.text);
            if (!parsed.ok) {
                return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
                    code: 'invalid_score',
                    details: parsed.message,
                });
            }
            return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
                code: null,
                score: parsed.score,
                details: parsed.details,
            });
        }

        const outside = response.blocks.find((b) => !allowed.has(b.name as never));
        if (outside) {
            return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
                code: 'tool_error_unrecoverable',
                details: `LLM requested tool not in allowlist: ${outside.name}`,
            });
        }

        messages.push({
            role: 'assistant',
            content: [
                ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
                ...response.blocks,
            ],
        });

        const results = await Promise.allSettled(
            response.blocks.map(async (block) => {
                try {
                    const output = await withTimeout(
                        executeTool(block, ctx, registry, options.toolExecutor),
                        toolTimeoutMs,
                    );
                    const bytes = Buffer.byteLength(output, 'utf8');
                    const record: JudgeToolCallRecord = {
                        name: block.name,
                        input: block.input,
                        ok: true,
                        bytes,
                    };
                    toolCalls.push(record);
                    recordToolCallLog(ctx, scorer, record, logEntries, emitLogs);
                    return toolResultBlock(block.id, output, false);
                } catch (err) {
                    const msg = getErrorMessage(err);
                    const record: JudgeToolCallRecord = {
                        name: block.name,
                        input: block.input,
                        ok: false,
                        bytes: 0,
                        errorMessage: msg,
                    };
                    toolCalls.push(record);
                    recordToolCallLog(ctx, scorer, record, logEntries, emitLogs);
                    return toolResultBlock(block.id, msg, true);
                }
            }),
        );

        const userBlocks: ToolResultBlock[] = results.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            return toolResultBlock(response.blocks[i].id, getErrorMessage(r.reason), true);
        });
        messages.push({ role: 'user', content: userBlocks });
    }

    return makeOutcome(tokenUsage, toolCalls, logEntries, rounds, {
        code: 'max_rounds',
        details: `Tool-use loop exhausted after ${rounds} rounds — consider increasing maxRounds (current: ${maxRounds}).`,
    });
}

type Outcome =
    | { code: null; score: number; details: string }
    | { code: JudgeErrorCode; details: string };

function makeOutcome(
    tokenUsage: TokenUsage,
    toolCalls: JudgeToolCallRecord[],
    logEntries: LogEntry[],
    rounds: number,
    outcome: Outcome,
): SessionOutcome {
    if (outcome.code === null) {
        return {
            code: null,
            score: outcome.score,
            details: outcome.details,
            rounds,
            toolCalls,
            tokenUsage,
            logEntries,
        };
    }
    return {
        code: outcome.code,
        details: outcome.details,
        rounds,
        toolCalls,
        tokenUsage,
        logEntries,
    };
}

async function executeTool(
    block: ToolUseBlock,
    ctx: ScorerContext,
    registry: ReadonlyMap<string, RegisteredTool>,
    override: ToolExecutor | undefined,
): Promise<string> {
    if (override) {
        return override(block.name, block.input, ctx);
    }
    const tool = registry.get(block.name);
    if (!tool) throw new Error(`Unknown tool: ${block.name}`);
    return tool.run(block.input, ctx);
}

function toolResultBlock(id: string, content: string, isError: boolean): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: id, content, is_error: isError };
}

function recordToolCallLog(
    ctx: ScorerContext,
    scorer: JudgeScorer,
    record: JudgeToolCallRecord,
    logEntries: LogEntry[],
    emitLogs: boolean,
): void {
    const entry: LogEntry = {
        type: 'judge_tool_call',
        timestamp: new Date().toISOString(),
        judge_tool_call: {
            name: record.name,
            input: record.input,
            ok: record.ok,
            bytes: record.bytes,
            errorMessage: record.errorMessage,
            judge_name: scorer.name,
        },
    };
    logEntries.push(entry);
    if (emitLogs) ctx.log.push(entry);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Tool call timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

function parseFinalScore(text: string):
    | { ok: true; score: number; details: string }
    | { ok: false; message: string }
{
    const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return { ok: false, message: `No JSON object found in final response: ${text.slice(0, 200)}` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
        return { ok: false, message: `JSON parse failed: ${getErrorMessage(err)}` };
    }
    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, message: 'Final JSON is not an object' };
    }
    const obj = parsed as Record<string, unknown>;
    const rawScore = obj.score;
    const numScore = typeof rawScore === 'number' ? rawScore : parseFloat(String(rawScore));
    if (!Number.isFinite(numScore) || numScore < 0 || numScore > 1) {
        return { ok: false, message: `Score out of range or not a number: ${String(rawScore)}` };
    }
    const details = typeof obj.details === 'string'
        ? obj.details
        : typeof obj.reasoning === 'string' ? obj.reasoning : '';
    return { ok: true, score: numScore, details };
}

