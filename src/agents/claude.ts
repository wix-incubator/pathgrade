import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, BlockedInteractivePrompt, CommandResult, EnvironmentHandle, VisibleAssistantMessageSource } from '../types.js';
import { ToolEvent, TOOL_NAME_MAP, buildSummary, enrichSkillEvents } from '../tool-events.js';
import { prependRuntimePolicies } from '../sdk/runtime-policy.js';
import { formatBlockedPrompt, getVisibleAssistantMessage } from '../sdk/visible-turn.js';
import { buildAskBatchFromClaudeDenials } from '../sdk/ask-bus/parsers.js';
import type { AskBus } from '../sdk/ask-bus/types.js';

interface PermissionDenial {
    tool_name: string;
    tool_use_id?: string;
    tool_input?: Record<string, unknown>;
}

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

interface ClaudeEnvelope {
    result?: string;
    session_id?: string;
    is_error?: boolean;
    permission_denials?: PermissionDenial[];
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
}

const API_ERROR_PATTERN = /^API Error:\s*\d{3}\b/;

function resolveClaudeExecutable(pathEnv = process.env.PATH, cwd = process.cwd()): string {
    if (!pathEnv) {
        return 'claude';
    }

    const candidates: string[] = [];
    for (const entry of pathEnv.split(path.delimiter)) {
        if (!entry) continue;
        const absoluteDir = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
        const candidate = path.join(absoluteDir, 'claude');
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            candidates.push(candidate);
        } catch {
            continue;
        }
    }

    if (candidates.length === 0) {
        return 'claude';
    }

    const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
    return candidates.find((candidate) => {
        const resolved = path.resolve(candidate);
        const isTempShim = resolved.startsWith(tmpRoot);
        const isNodeModulesShim = resolved.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`);
        return !isTempShim && !isNodeModulesShim;
    }) ?? candidates[0];
}

export class ClaudeAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        let sessionId: string | undefined;
        let turnNumber = 0;
        const mcpConfigPath = options?.mcpConfigPath;
        const model = options?.model;
        const runtimePolicies = options?.runtimePolicies ?? [];
        const askBus = options?.askBus;

        return {
            start: async ({ message }) => {
                turnNumber += 1;
                const result = await this.runTurn(message, runCommand, undefined, mcpConfigPath, runtimePolicies, model, askBus, turnNumber);
                sessionId = result.sessionId;
                return result;
            },
            reply: async ({ message }) => {
                turnNumber += 1;
                const result = await this.runTurn(message, runCommand, sessionId, mcpConfigPath, runtimePolicies, model, askBus, turnNumber);
                return result;
            },
        };
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const result = await this.runTurn(instruction, runCommand, undefined, undefined);
        return getVisibleAssistantMessage(result);
    }

    private async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        sessionId: string | undefined,
        mcpConfigPath: string | undefined,
        runtimePolicies: AgentSessionOptions['runtimePolicies'] = [],
        model?: string,
        askBus?: AskBus,
        turnNumber?: number,
    ): Promise<AgentTurnResult & { sessionId?: string }> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';
        const appliedRuntimePolicies = sessionId ? [] : [...(runtimePolicies ?? [])];
        const promptInstruction = appliedRuntimePolicies.length > 0
            ? prependRuntimePolicies(instruction, appliedRuntimePolicies, { agent: 'claude' })
            : instruction;

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(promptInstruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        // Use --output-format stream-json --verbose to capture tool call traces.
        // For continuation, use --resume to target the exact session from turn 1.
        const sanitized = sessionId ? this.sanitizeSessionId(sessionId) : undefined;
        const sessionFlag = sanitized ? ` --resume ${sanitized}` : '';
        const modelFlag = model ? ` --model ${model}` : '';
        const mcpFlag = mcpConfigPath ? ` --mcp-config "${mcpConfigPath}"` : '';
        const claudeExecutable = resolveClaudeExecutable();
        const command = `"${claudeExecutable}" -p${sessionFlag}${modelFlag}${mcpFlag} --output-format stream-json --verbose --dangerously-skip-permissions "$(cat ${promptPath})" < /dev/null`;
        const result = await runCommand(command);

        // Parse the NDJSON stream to extract result text, session_id, and tool traces.
        const parsed = this.parseStreamJson(result.stdout);
        const rawOutput = parsed.resultFound
            ? parsed.text
            : (result.stdout + '\n' + result.stderr);

        const isFirstTurn = !sessionId;
        const toolEvents = extractClaudeStreamJsonEvents(result.stdout, undefined, isFirstTurn ? instruction : undefined);

        if (askBus && parsed.denials.length > 0) {
            const askQuestionDenials = parsed.denials.filter((d) => d.tool_name === 'AskUserQuestion');
            if (askQuestionDenials.length > 0) {
                askBus.emit(buildAskBatchFromClaudeDenials(askQuestionDenials, turnNumber ?? 0));
            }
        }

        return {
            rawOutput,
            // Error text must not become an assistant message (would corrupt conversation),
            // but is preserved in rawOutput for diagnostics.
            assistantMessage: parsed.isError ? '' : rawOutput.trim(),
            visibleAssistantMessage: parsed.isError ? '' : parsed.visibleAssistantMessage.trim(),
            visibleAssistantMessageSource: parsed.visibleAssistantMessageSource,
            exitCode: result.exitCode,
            sessionId: parsed.extractedSessionId,
            traceOutput: result.stdout,
            timedOut: result.timedOut,
            blockedPrompts: parsed.blockedPrompts,
            toolEvents,
            runtimePoliciesApplied: appliedRuntimePolicies,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
        };
    }

    private sanitizeSessionId(id: string): string {
        // Claude session IDs are alphanumeric with hyphens and underscores
        const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
        if (sanitized !== id) {
            console.warn(`ClaudeAgent: sanitized suspicious session_id: ${id.substring(0, 50)}`);
        }
        return sanitized;
    }

    /**
     * Parse NDJSON from --output-format stream-json --verbose.
     * Each line is a JSON object. The `result` line contains the final text and session_id.
     */
    private parseStreamJson(stdout: string): {
        text: string;
        extractedSessionId?: string;
        resultFound: boolean;
        isError?: boolean;
        inputTokens?: number;
        outputTokens?: number;
        blockedPrompts: BlockedInteractivePrompt[];
        visibleAssistantMessage: string;
        visibleAssistantMessageSource: VisibleAssistantMessageSource;
        denials: PermissionDenial[];
    } {
        let resultEnvelope: ClaudeEnvelope | undefined;

        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'result') {
                    resultEnvelope = parsed;
                    break;
                }
            } catch {
                continue;
            }
        }

        if (!resultEnvelope) {
            return {
                text: '',
                resultFound: false,
                blockedPrompts: [],
                visibleAssistantMessage: '',
                visibleAssistantMessageSource: 'assistant_message',
                denials: [],
            };
        }

        const extractedSessionId = resultEnvelope.session_id;
        const usage = resultEnvelope.usage;
        const inputTokens = usage
            ? (usage.input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0)
                + (usage.cache_read_input_tokens ?? 0)
            : undefined;
        const outputTokens = usage?.output_tokens;

        const denials = resultEnvelope.permission_denials ?? [];
        const blockedPrompts = this.extractBlockedPrompts(denials);
        const visibleAssistantMessageSource: VisibleAssistantMessageSource = blockedPrompts.length > 0
            ? 'blocked_prompt'
            : 'assistant_message';
        const visibleAssistantMessage = blockedPrompts.length > 0
            ? formatBlockedPrompt(blockedPrompts[0])
            : '';

        // Detect API errors — preserve error text for diagnostics, but flag so callers
        // don't use it as an assistant message (which would corrupt the conversation).
        if (resultEnvelope.is_error || (resultEnvelope.result && API_ERROR_PATTERN.test(resultEnvelope.result))) {
            return {
                text: resultEnvelope.result ?? '',
                extractedSessionId,
                resultFound: true,
                isError: true,
                inputTokens,
                outputTokens,
                blockedPrompts: [],
                visibleAssistantMessage: '',
                visibleAssistantMessageSource: 'assistant_message',
                denials,
            };
        }

        // Use the result text if available
        if (resultEnvelope.result) {
            return {
                text: resultEnvelope.result,
                extractedSessionId,
                resultFound: true,
                inputTokens,
                outputTokens,
                blockedPrompts,
                visibleAssistantMessage: visibleAssistantMessage || resultEnvelope.result,
                visibleAssistantMessageSource,
                denials,
            };
        }

        // Generic fallback: extract any text-like field from denied tool inputs
        if (denials.length > 0) {
            const text = this.reconstructFromGenericDenial(denials);
            if (text) {
                return {
                    text,
                    extractedSessionId,
                    resultFound: true,
                    inputTokens,
                    outputTokens,
                    blockedPrompts,
                    visibleAssistantMessage: visibleAssistantMessage || text,
                    visibleAssistantMessageSource,
                    denials,
                };
            }
        }

        return {
            text: '',
            extractedSessionId,
            resultFound: true,
            inputTokens,
            outputTokens,
            blockedPrompts,
            visibleAssistantMessage,
            visibleAssistantMessageSource,
            denials,
        };
    }

    /**
     * Reconstruct a text message from a denied AskUserQuestion tool call.
     * This happens when Claude tries to use the interactive AskUserQuestion
     * tool in --print mode and it gets denied, leaving result empty.
     */
    /**
     * Extract text from any denied tool by looking for common text-like fields.
     */
    private reconstructFromGenericDenial(denials: PermissionDenial[]): string {
        const textFields = ['question', 'message', 'prompt', 'text', 'content', 'description'];
        for (const denial of denials) {
            if (!denial.tool_input) continue;
            for (const field of textFields) {
                const value = denial.tool_input[field];
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
        }
        return '';
    }

    private extractBlockedPrompts(denials: PermissionDenial[]): BlockedInteractivePrompt[] {
        const prompts: BlockedInteractivePrompt[] = [];
        for (const denial of denials) {
            if (denial.tool_name !== 'AskUserQuestion' || !denial.tool_input) {
                continue;
            }

            const input = denial.tool_input as AskUserQuestionInput;
            for (const question of input.questions ?? []) {
                if (!question.question?.trim()) {
                    continue;
                }
                prompts.push({
                    prompt: question.question.trim(),
                    header: question.header?.trim(),
                    options: (question.options ?? []).map((option) => ({
                        label: option.label,
                        ...(option.description ? { description: option.description } : {}),
                    })),
                    sourceTool: denial.tool_name,
                    ...(denial.tool_use_id ? { toolUseId: denial.tool_use_id } : {}),
                    order: prompts.length,
                });
            }
        }
        return prompts;
    }
}

/**
 * Parse Claude's --output-format stream-json --verbose NDJSON output.
 * Each line is a JSON object. Tool calls appear in `assistant` messages
 * as content blocks with `type: "tool_use"`.
 */
export function extractClaudeStreamJsonEvents(
  traceOutput: string,
  turnNumber?: number,
  firstMessage?: string,
): ToolEvent[] {
  const events: ToolEvent[] = [];
  let initSkills: string[] | undefined;

  for (const line of traceOutput.split('\n')) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'system' && parsed.subtype === 'init' && Array.isArray(parsed.skills)) {
      initSkills = parsed.skills as string[];
    }

    if (parsed.type !== 'assistant') continue;

    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;

      const providerToolName = String(block.name || 'unknown');
      const args = (block.input as Record<string, unknown>) || undefined;
      const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
      const summary = buildSummary(action, providerToolName, args);
      const rawSnippet = JSON.stringify(block).slice(0, 200);

      events.push({
        action,
        provider: 'claude',
        providerToolName,
        turnNumber,
        arguments: args,
        summary,
        confidence: 'high',
        rawSnippet,
      });
    }
  }

  const enriched = enrichSkillEvents(events);

  // Detect slash-command skill usage: if the first message starts with /skill-name
  // and that name is in the init event's skills array, prepend a synthetic use_skill event.
  if (firstMessage && initSkills) {
    const match = firstMessage.match(/^\/([^\s]+)/);
    if (match && initSkills.includes(match[1])) {
      const skillName = match[1];
      enriched.unshift({
        action: 'use_skill',
        provider: 'claude',
        providerToolName: 'Skill',
        arguments: { skill: skillName },
        skillName,
        summary: `use_skill "${skillName}"`,
        confidence: 'high',
        rawSnippet: '(detected from slash command in prompt)',
      });
    }
  }

  return enriched;
}
