import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

interface PermissionDenial {
    tool_name: string;
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
}

const API_ERROR_PATTERN = /^API Error:\s*\d{3}\b/;

export class ClaudeAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        let sessionId: string | undefined;
        const mcpConfigPath = options?.mcpConfigPath;

        return {
            start: async ({ message }) => {
                const result = await this.runTurn(message, runCommand, undefined, mcpConfigPath);
                sessionId = result.sessionId;
                return result;
            },
            reply: async ({ message }) => {
                const result = await this.runTurn(message, runCommand, sessionId, mcpConfigPath);
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
        return result.rawOutput;
    }

    private async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        sessionId: string | undefined,
        mcpConfigPath: string | undefined
    ): Promise<AgentTurnResult & { sessionId?: string }> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        // Use --output-format stream-json --verbose to capture tool call traces.
        // For continuation, use --resume to target the exact session from turn 1.
        const sanitized = sessionId ? this.sanitizeSessionId(sessionId) : undefined;
        const sessionFlag = sanitized ? ` --resume ${sanitized}` : '';
        const mcpFlag = mcpConfigPath ? ` --mcp-config "${mcpConfigPath}"` : '';
        const command = `claude -p${sessionFlag}${mcpFlag} --output-format stream-json --verbose --dangerously-skip-permissions "$(cat ${promptPath})" < /dev/null`;
        const result = await runCommand(command);

        // Parse the NDJSON stream to extract result text, session_id, and tool traces.
        const parsed = this.parseStreamJson(result.stdout);
        const rawOutput = parsed.resultFound
            ? parsed.text
            : (result.stdout + '\n' + result.stderr);

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
            sessionId: parsed.extractedSessionId,
            // traceOutput contains the full NDJSON stream for tool event extraction
            traceOutput: result.stdout,
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
    private parseStreamJson(stdout: string): { text: string; extractedSessionId?: string; resultFound: boolean } {
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

        if (!resultEnvelope) return { text: '', resultFound: false };

        const extractedSessionId = resultEnvelope.session_id;

        // Detect API errors — these should not become assistant messages.
        if (resultEnvelope.is_error || (resultEnvelope.result && API_ERROR_PATTERN.test(resultEnvelope.result))) {
            return { text: '', extractedSessionId, resultFound: true };
        }

        // Use the result text if available
        if (resultEnvelope.result) {
            return { text: resultEnvelope.result, extractedSessionId, resultFound: true };
        }

        // When result is empty (e.g. AskUserQuestion denied in --print mode),
        // reconstruct a text response from the denied tool's input.
        const denials = resultEnvelope.permission_denials ?? [];
        const askDenial = denials.find(d => d.tool_name === 'AskUserQuestion');
        if (askDenial?.tool_input) {
            const text = this.reconstructFromAskUserQuestion(askDenial.tool_input as AskUserQuestionInput);
            if (text) return { text, extractedSessionId, resultFound: true };
        }

        // Generic fallback: extract any text-like field from denied tool inputs
        if (denials.length > 0) {
            const text = this.reconstructFromGenericDenial(denials);
            if (text) return { text, extractedSessionId, resultFound: true };
        }

        return { text: '', extractedSessionId, resultFound: true };
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

    private reconstructFromAskUserQuestion(input: AskUserQuestionInput): string {
        const questions = input.questions;
        if (!questions?.length) return '';

        const parts: string[] = [];
        for (const q of questions) {
            if (q.header) parts.push(`**${q.header}**`);
            parts.push(q.question);
            if (q.options?.length) {
                for (const opt of q.options) {
                    const desc = opt.description ? ` — ${opt.description}` : '';
                    parts.push(`- **${opt.label}**${desc}`);
                }
            }
        }
        return parts.join('\n');
    }
}
